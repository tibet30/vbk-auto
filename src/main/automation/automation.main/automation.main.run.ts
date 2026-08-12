/**
 * 自动化阶段主循环入口：runAutomation。
 *   - 拉项目 / 解析 product；
 *   - 前置兜底：setVisible + ensureBrowserHasBounds；
 *   - 自动化 blocker 检查 + 管家联系人 / 400 电话凭证准备；
 *   - 根据 startIndex（首次或 retryFrom）创建或重置 AutomationRun；
 *   - 用 handlers Map 把每个 phase 包成 local execute，runPhaseWithRecovery
 *     负责尝试 → advisor → 决策；
 *   - cancelled 由 AutomationCancelledError 短路，failed 落库 blocked 状态。
 *
 * 设计偏好：「在当前页面去重试」—— advisor 的 reload/reopen 动作走 noop，
 * 不强制拽回 basic tab，避免把页面状态丢失。
 */

import { randomUUID } from "node:crypto";
import { runPhaseWithRecovery, type RecoveryContext } from "../recovery/recovery.js";
import { preparePhaseRetry } from "../phase-retry.js";
import {
  automationBlockers,
  parseProduct,
  pickKeySpotsFromItinerary,
  shouldRefillBasicInfo,
} from "../schema/schema.js";
import {
  configureProductShell,
  ensureHotelResource,
  ensureVehicleResource,
  fillAndSaveBasicInfo,
  fillAndSavePackage,
  fillAndSavePresentation,
  fillAndSaveTerms,
  fillAndSubmitPricingInventory,
  fillItineraryDraft,
  openProductEditor,
  runProductPreflight,
  saveScreenshot,
} from "../ctrip/ctrip.js";
import { draftPhasesFor } from "./automation.main.phases.js";
import { resolveActiveServicePhoneContext, resolveProductButlerSelection } from "./automation.main.class.helpers.js";
import { finalizeRunWithScreenshot } from "./automation.main.run.finalize.js";
import { AutomationCancelledError } from "./automation.main.errors.js";
import type { AutomationRunContext } from "./automation.main.context.js";
import type { AutomationRun, ContactCardSelection } from "../../../shared/contracts.js";

/**
 * 单个项目自动化阶段主循环：
 *   - retryFrom 为 undefined 时从第 0 阶段跑完整轮；否则按 preparePhaseRetry 重置并按该阶段重跑；
 *   - 任一阶段 needs_user → run.status="failed" + 更新 product 为 blocked 并 return；
 *   - 任一阶段 cancelled → ctx.markCancelled 接管；handler 抛错走 catch；
 *   - 全部完成 → status=succeeded，附 desktop-draft 截图落档。
 *
 * 把持续状态（attempts / logs / phases）持久化到 ctx.db.saveAutomation(projectId, run)，
 * UI 端通过 ctx.emit(projectId) 拿更新。
 */
export async function runAutomation(ctx: AutomationRunContext, projectId: string, retryFrom?: string) {
    const project = ctx.db.getProject(projectId);
    if (!project) throw new Error("项目不存在");
    const product = parseProduct(project.product);
    // 触发前先决：让 VBK 视图可见并兑底 bounds。
    // 这些调用必须在后面任何预检查 / 阶段 runner 之前完成，否则：
    //   1) view 隐藏时 setVisible 没调，Playwright 连接后看到 window.innerHeight=0
    //   2) view 没填满窗口时 auto-scroll 跟不动，click 30s 超时
    //   3) 但预检查（管家 / 400 电话 / blockers）会在 view 还没就绪时抛错，
    //      把 ensureBrowserHasBounds 这一兑底短路掉。
    ctx.browser.setVisible(true);
    ctx.ensureBrowserHasBounds();
    // 后面几个阶段强制要求这些字段，但它们在 productSchema 里是可选的。
    // 必须在创建远程草稿之前拦下，否则会在携程留下一个半成品产品。
    const blockers = automationBlockers(project.product);
    if (blockers.length) {
      throw new Error(`录入前检查未通过：${blockers.map((item) => item.label).join("、")}`);
    }
    // product JSON 里的「管家联系人」是 basic 阶段实际依赖的来源；创建项目时
    // 已从账号固定信息固化进去，自动化阶段不再回读账号 butlerName，避免账号
    // 后续改动覆盖当前产品负责人。400 电话仍来自账号固定信息。
    const draftPhases = draftPhasesFor(product);
    const startIndex = retryFrom ? draftPhases.indexOf(retryFrom) : 0;
    if (retryFrom && startIndex < 0) throw new Error(`当前产品没有阶段：${retryFrom}`);
    if (retryFrom && !project.productId) throw new Error("远程草稿尚未创建，不能从中间阶段重试。");
    let basicInfoSaved = project.basicInfoSaved ?? false;

    const accountName = ctx.db.getSetting("vbkAccountName")?.value;
    // 全量重跑从 basic 阶段起点，需要管家联系人；若从中间阶段重试且 basic 已成功，
    // 默认不再要求管家联系人，避免已完成信息下重复因显示名漂移导致阻断。
    const shouldRequireAccountContext = startIndex === 0 || !basicInfoSaved;
    let butlerSelection: ContactCardSelection | null = null;
    let servicePhone = "";
    if (shouldRequireAccountContext) {
      butlerSelection = resolveProductButlerSelection(project.product);
      if (!butlerSelection) {
        throw new Error("录入前检查未通过：产品 JSON 缺少管家联系人（请重新创建或在基础信息中写入负责人）");
      }
      const phoneContext = resolveActiveServicePhoneContext(ctx.db, accountName);
      if (!phoneContext) {
        if (!accountName) throw new Error("未检测到当前登录的 VBK 账号，无法读取 400 电话。");
        throw new Error("录入前检查未通过：400 电话（请在账号设置里维护）");
      }
      servicePhone = phoneContext.servicePhone;
      if (phoneContext.fallbackUsed) {
        ctx.db.setSetting("vbkAccountName", phoneContext.accountName);
      }
    } else {
      const phoneContext = resolveActiveServicePhoneContext(ctx.db, accountName);
      if (phoneContext?.fallbackUsed) {
        ctx.db.setSetting("vbkAccountName", phoneContext.accountName);
      }
    }
    // 国家景区内具体景点：按行程顺序提取全部 spots[].name；不可匹配的单项
    // 由 fillAndSaveBasicInfo 内部追加到 scenicSpotLogs，再在每轮结束时
    // 落盘到 automation log，便于人工核对。
    const keySpots = pickKeySpotsFromItinerary(project.product);
    const scenicSpotLogs: string[] = [];

    if (retryFrom && !project.automation) throw new Error("没有可重试的自动录入记录。");
    const run: AutomationRun = retryFrom
      ? preparePhaseRetry(project.automation!, draftPhases, retryFrom)
      : { id: randomUUID(), status: "running", phases: draftPhases.map((phase) => ({ phase, status: "pending" })), logs: [] };
    const log = (message: string, level: "info" | "warning" | "error" = "info") => { run.logs.push({ at: new Date().toISOString(), message, level }); ctx.db.saveAutomation(projectId, run); ctx.emit(projectId); };
    const persist = () => { ctx.db.saveAutomation(projectId, run); ctx.emit(projectId); };
    ctx.db.saveAutomation(projectId, run);
    ctx.db.updateProduct(projectId, project.product, "automating");
    // setVisible + ensureBrowserHasBounds 已在 run 入口提前调用，
    // 保证后面预检查 / 阶段 runner 不会因 view 未就绪拖崩 click。
    try {
      const page = await ctx.browser.page();
      let productId = project.productId;
      if (startIndex === 0) {
        run.currentPhase = "basic"; run.phases[0].status = "running";
        if (!productId) {
          log("正在创建 VBK 产品草稿…");
          // configureProductShell 现在原子化完成销售控制（产品类型/形态/线路品牌
          // /分销渠道 + 点下一步），并返回携程产品 ID，不再单独调 createProductShell。
          productId = (await configureProductShell(page, product)) as string;
          ctx.db.setProductId(projectId, productId);
        } else {
          log("正在重跑 basic 阶段…", "warning");
          await openProductEditor(page, productId);
        }
        if (!productId) throw new Error("产品 ID 缺失，无法继续后续阶段。");
        log(`产品基本信息阶段开始：${productId}`);
      } else {
        // 从中间阶段重试：用户偏好「在当前页面去重试」 —— 不再调
        // openProductEditor 去拽回「基本信息」 tab，也不进行“重新幂等录入
        // 产品信息”避免重复填表。页面应已停在原产品某子 tab 上；阶段
        // handler 各自负责跳到自己的 tab（fillItineraryDraft 会 clickSection
        // 切到「行程描述」）。仅在页面不是产品编辑器时才补一次导航。
        await openProductEditor(page, productId!, { stayOnCurrentTab: true });
        log(`已从 ${retryFrom} 阶段继续录入（当前页面）`);
      }

      // 每个 phase 处理器共享一份 productId 闭包，并独立被 runPhaseWithRecovery 包裹。
      const phaseRecord = (phase: string) => {
        const index = draftPhases.indexOf(phase);
        if (index < 0) throw new Error(`未注册的阶段：${phase}`);
        run.currentPhase = phase;
        run.phases[index].status = "running";
        persist();
      };

      const basicExecute = async () => {
        phaseRecord("basic");
        // runner 重试本阶段时清空 scenicSpotLogs，防止把上一轮未命中的景点
        // 单项重复记入 automation 日志。
        scenicSpotLogs.length = 0;
        const shouldRefill = shouldRefillBasicInfo({ productId, basicInfoSaved, product: project.product });
        log(`basic 阶段开始（reason=${shouldRefill.reason}）`);
        if (!productId) throw new Error("产品 ID 缺失，无法继续后续阶段。");
        await fillAndSaveBasicInfo(page, product, butlerSelection, { servicePhone, keySpots, scenicSpotLogs, disambiguator: ctx.disambiguator });
        // 把景点未命中的单项沉淀到 automation 日志。
        for (const entry of scenicSpotLogs) log(entry, "warning");
        // 仅当 VBK 真实保存成功后置位；setBasicInfoSaved 由 fillAndSaveBasicInfo
        // 通过 tab 解锁门禁间接验证，runner 不能因此前置。
        ctx.db.setBasicInfoSaved(projectId);
        basicInfoSaved = true;
        run.phases[0].status = "completed";
      };

      const handlers: Record<string, () => Promise<unknown>> = {
        presentation: async () => { phaseRecord("presentation"); const r = await fillAndSavePresentation(page, product); run.phases[draftPhases.indexOf("presentation")].status = "completed"; return r; },
        itinerary: async () => { phaseRecord("itinerary"); const r = await fillItineraryDraft(page, product, { disambiguator: ctx.disambiguator, productId }); run.phases[draftPhases.indexOf("itinerary")].status = "completed"; return r; },
        package: async () => { phaseRecord("package"); const r = await fillAndSavePackage(page, product); run.phases[draftPhases.indexOf("package")].status = "completed"; return r; },
        pricingInventory: async () => { phaseRecord("pricingInventory"); const r = await fillAndSubmitPricingInventory(page, product, productId!); run.phases[draftPhases.indexOf("pricingInventory")].status = "completed"; return r; },
        terms: async () => { phaseRecord("terms"); const r = await fillAndSaveTerms(page, product); run.phases[draftPhases.indexOf("terms")].status = "completed"; return r; },
        hotelResource: async () => {
          phaseRecord("hotelResource");
          const result = await ensureHotelResource(page, product, productId!);
          if (result.source === "vbk" && result.resourceId && result.resourceName) {
            product.operations!.hotelResource = {
              source: "vbk",
              resourceId: result.resourceId,
              resourceName: result.resourceName,
              hotelTier: result.hotelTier,
              diamond: result.diamond as 3 | 4 | 5,
            };
            ctx.db.updateProduct(projectId, product as unknown as Record<string, unknown>, "automating");
          }
          run.phases[draftPhases.indexOf("hotelResource")].status = "completed";
          return result;
        },
        vehicleResource: async () => { phaseRecord("vehicleResource"); const r = await ensureVehicleResource(page, product, productId!); run.phases[draftPhases.indexOf("vehicleResource")].status = "completed"; return r; },
        preflight: async () => { phaseRecord("preflight"); const r = await runProductPreflight(page, product, productId!); run.phases[draftPhases.indexOf("preflight")].status = "completed"; return r; },
      };

      // 重建 ctx 的 factory：每个阶段都使用同一份 run；同一 runner 第二次进入时
      // 会重置 attempts（recovery.ts 已保证）。
      //
      // productIdExists 每次进入阶段都重新从 DB 读取最新值：basic 阶段成功后
      // 会通过 setProductId 落库，但若 basic 失败后这一轮被外部（例如 UI
      // 重试或 orphan recover）触发再次进入，闭包内的本地 productId 仍是
      // 旧值；从 DB 读能避免 advisor 拿到 stale productIdExists=false 误判
      // reopen_editor_and_retry_phase。basicInfoSaved 仍走同步读取，因为
      // 它由本次 runner 在 basic 成功后置位，不会被外部并发覆盖。
      const makeCtx = (phase: string, execute: () => Promise<unknown>, phaseIndex: number): RecoveryContext => {
        const latestProductId = ctx.db.getProject(projectId)?.productId;
        return {
        run,
        phase,
        completedPhases: draftPhases.slice(0, phaseIndex),
        productIdExists: Boolean(latestProductId),
        basicInfoSaved,
        execute,
        advisor: ctx.advisor,
        applyAction: async (action) => {
          // 仅白名单动作能落到浏览器：只接受 wait_for_user 真正停手；其余
          // 三个重试动作全部一律 Noop —— 用户偏好「在当前页面去重试」，
          // 不希望 reload_and_retry_phase / reopen_editor_and_retry_phase
          // 重新打开产品编辑器（会带页面跳回“基本信息” tab 并造成上次状
          // 态丢失）。advisor 提议的诊断信息仍会落盘到 attemptsHistory
          // 以供下次会话接手；仅不再执行 reload / reopen 动作。
          if (action === "wait_for_user") {
            throw new Error("applyAction 不应收到 wait_for_user");
          }
          log(`applyAction noop action=${action} phase=${phase}（当前页面重试偏好）`, "info");
        },
        log,
        persist,
        // 「停止」按钮会写进 cancellationRequested。recovery 在 attempt
        // 顶部检查；in-flight handler 不打断（Playwright click 跨进程无
        // 安全中断点，强制中断会让浏览器页面留下半成品状态）。
        shouldCancel: () => ctx.cancellationRequested.has(projectId),
        };
      };

      // basic 阶段也走 runner：attempt 1..3，最多 3 次；runner 不创建新草稿。
      // 仅在 startIndex === 0（首次运行或重跑 basic）时跑 basic；中间阶段
      // 重试（startIndex > 0）偏好「在当前页面去重试」，不再强制跑 basic
      // 段，信任之前的 basic 阶段已完成，避免其 clickSection 把页面拽回
      // 「基本信息」 tab 并造成上次状态丢失。
      if (startIndex === 0) {
        const basicOutcome = await runPhaseWithRecovery(makeCtx("basic", basicExecute, 0));
        if (basicOutcome.status === "needs_user") {
          run.status = "failed";
          run.phases[0].status = "failed";
          run.currentPhase = "basic";
          ctx.db.updateProduct(projectId, project.product, "blocked");
          persist();
          return;
        }
        if (basicOutcome.status === "cancelled") {
          ctx.markCancelled(projectId, run, persist);
          return;
        }
      } else {
        log(`跳过 basic 阶段（已保存），从 ${retryFrom} 继续（当前页面重试）`);
      }

      if (!productId) throw new Error("产品 ID 缺失，无法继续后续阶段。");
      log(`产品基本信息已保存：${productId}`);

      const startFrom = Math.max(1, startIndex);
      for (let index = startFrom; index < draftPhases.length; index += 1) {
        const phase = draftPhases[index];
        const handler = handlers[phase];
        if (!handler) throw new Error(`未注册的阶段：${phase}`);
        log(`正在保存：${phase}`);
        const outcome = await runPhaseWithRecovery(makeCtx(phase, handler, index));
        if (outcome.status === "needs_user") {
          run.status = "failed";
          run.phases[index].status = "failed";
          run.currentPhase = phase;
          ctx.db.updateProduct(projectId, project.product, "blocked");
          persist();
          return;
        }
        if (outcome.status === "cancelled") {
          ctx.markCancelled(projectId, run, persist);
          return;
        }
        log(`已保存：${phase}`);
      }
      // 全部业务阶段成功后的收尾：best-effort screenshot（捕获 saveScreenshot
      // 错误，避免页面 width=0 / page 已 detach 等竞态把整条 run 误标
      // failed/blocked），然后切产品状态 draft_saved 并 persist。screenshot
      // 失败仅写一条 warning log，业务成功状态保持 succeeded + undefined +
      // draft_saved，绝不进入 failed/blocked 路径。
      run.status = "succeeded";
      run.currentPhase = undefined;
      await finalizeRunWithScreenshot(run, saveScreenshot, productId!, page, log);
      log("产品草稿已保存，未提交审核、未发布。", "warning");
      ctx.db.updateProduct(projectId, product as unknown as Record<string, unknown>, "draft_saved");
      persist();
    } catch (error) {
      // 「停止」流程不应该被 catch 当作 failed —— stop() 已经把 run.status
      // 改为 cancelled 并 emit 过，这里只需清理 cancellationRequested 后
      // 静默返回，不要覆盖状态。
      if (error instanceof AutomationCancelledError) {
        ctx.cancellationRequested.delete(projectId);
        return;
      }
      // handler 内部可能因为 stop 之外的其他原因抛错 —— 现有逻辑保持不变。
      run.status = "failed";
      const current = run.phases.find((phase: { phase: string; status: string }) => phase.phase === run.currentPhase);
      if (current && current.status !== "completed") current.status = "failed";
      log(error instanceof Error ? error.message : "自动录入发生未知错误", "error");
      ctx.db.updateProduct(projectId, project.product, "blocked");
      persist();
      throw error;
    } finally {
      // 走完所有阶段后清理取消信号 —— 防止下一次 run 进来时拿到的 stale flag。
      ctx.cancellationRequested.delete(projectId);
    }
  }
