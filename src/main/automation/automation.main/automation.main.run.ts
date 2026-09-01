/**
 * 自动化阶段主循环入口：runAutomation。
 *   - 拉产品 / 解析 product；
 *   - 前置兜底：setVisible + ensureBrowserHasBounds；
 *   - 自动化 blocker 检查 + 管家联系人 / 400 电话凭证准备；
 *   - 根据 startIndex（首次或 retryFrom）创建或重置 AutomationRun；
 *   - 用 handlers Map 把每个 phase 包成 local execute，runPhaseWithRecovery
 *     负责尝试 → advisor → 决策；
 *   - cancelled 由 AutomationCancelledError 短路，failed 落库 blocked 状态。
 *
 * 设计偏好：每次 recovery 重试前先刷新当前 phase 的编辑页，再重新执行 handler，
 * 避免图片 / 富文本等 VBK 页面脏状态泄漏到下一轮。
 */

import { randomUUID } from "node:crypto";
import { runPhaseWithRecovery, type RecoveryContext } from "../recovery/recovery.js";
import { preparePhaseRetry, prepareQueuedPhaseResume } from "../phase-retry.js";
import {
  automationBlockers,
  parseProduct,
  pickKeySpotsFromItinerary,
  shouldRefillBasicInfo,
} from "../schema/schema.js";
import {
  fillAndSaveTerms,
  saveScreenshot,
} from "../ctrip/ctrip.js";
import { fillItineraryDraftApi } from "../ctrip/itinerary/api-entry.js";
import { draftPhasesFor } from "./automation.main.phases.js";
import { refreshSupplierProductCodeForPlatformWrite, resolveActiveServicePhoneContext, resolveProductButlerSelection } from "./automation.main.class.helpers.js";
import { finalizeRunWithScreenshot } from "./automation.main.run.finalize.js";
import { AutomationCancelledError } from "./automation.main.errors.js";
import { executeApiWithPhasePageSync, recordPhaseRetry } from "./automation.main.retry-navigation.js";
import { ensurePricingInventoryApi } from "../ctrip/pricing-api.js";
import { ensurePackageApi } from "../ctrip/package-api.js";
import {
  ensureBasicInfoApi,
  hasProductLineResolutionFailure,
  isProductLineResolutionError,
} from "../ctrip/basic-info/api.js";
import { configureProductShellApi } from "../ctrip/sale-control/api.js";
import { ensureHotelResourceApi } from "../ctrip/hotel-resource-api.js";
import { runProductPreflightApi } from "../ctrip/preflight-api.js";
import { ensureVehicleResourceApi } from "../ctrip/vehicle-resource-api.js";
import type { AutomationRunContext } from "./automation.main.context.js";
import type { AutomationRun, ContactCardSelection } from "../../../shared/contracts.js";
import { fillPresentationWithSensitiveRewrite } from "./presentation-sensitive-rewrite.js";
import { fillItineraryWithSensitiveRewrite } from "./itinerary-sensitive-rewrite.js";
import { completeVerifiedSaleControlPhase, initializeAutomationStartPhase } from "./automation.main.run-state.js";
import { normalizeUnsupportedProductTypeBeforeShell } from "./automation.main.product-type.js";

/**
 * 单个产品自动化阶段主循环：
 *   - retryFrom 为 undefined 时从第 0 阶段跑完整轮；否则按 preparePhaseRetry 重置并按该阶段重跑；
 *   - 任一阶段 needs_user → run.status="failed" + 更新 product 为 blocked 并 return；
 *   - 任一阶段 cancelled → ctx.markCancelled 接管；handler 抛错走 catch；
 *   - 全部完成 → status=succeeded，附 desktop-draft 截图落档。
 *
 * 把持续状态（attempts / logs / phases）持久化到 ctx.db.saveAutomation(localProductId, run)，
 * UI 端通过 ctx.emit(localProductId) 拿更新。
 */
export async function runAutomation(ctx: AutomationRunContext, localProductId: string, retryFrom?: string) {
    const productDetail = ctx.db.getProduct(localProductId);
    if (!productDetail) throw new Error("产品不存在");
    const normalizedProductType = normalizeUnsupportedProductTypeBeforeShell(
      productDetail.product,
      productDetail.productId,
    );
    productDetail.product = normalizedProductType.product;
    const product = parseProduct(productDetail.product);
    // 用户离开 VBK 页面后，自动化继续复用隐藏会话；不重新打开 BrowserView。
    // 后面几个阶段强制要求这些字段，但它们在 productSchema 里是可选的。
    // 必须在创建远程草稿之前拦下，否则会在携程留下一个半成品产品。
    const blockers = automationBlockers(productDetail.product);
    if (blockers.length) {
      throw new Error(`录入前检查未通过：${blockers.map((item) => item.label).join("、")}`);
    }
    // product JSON 里的「管家联系人」是 basic 阶段实际依赖的来源；创建产品时
    // 已从账号固定信息固化进去，自动化阶段不再回读账号 butlerName，避免账号
    // 后续改动覆盖当前产品负责人。400 电话仍来自账号固定信息。
    const draftPhases = draftPhasesFor(product);
    const startIndex = retryFrom ? draftPhases.indexOf(retryFrom) : 0;
    if (retryFrom && startIndex < 0) throw new Error(`当前产品没有阶段：${retryFrom}`);
    if (retryFrom && !productDetail.productId) throw new Error("远程草稿尚未创建，不能从中间阶段重试。");
    let basicInfoSaved = productDetail.basicInfoSaved ?? false;
    let productLineBlocked = hasProductLineResolutionFailure(
      productDetail.automation?.recovery?.phases.basic,
    );

    const accountName = ctx.db.getSetting("vbkAccountName")?.value;
    // 全量重跑从 basic 阶段起点，需要管家联系人；若从中间阶段重试且 basic 已成功，
    // 默认不再要求管家联系人，避免已完成信息下重复因显示名漂移导致阻断。
    const shouldRequireAccountContext = startIndex === 0 || !basicInfoSaved;
    let butlerSelection: ContactCardSelection | null = null;
    let servicePhone = "";
    if (shouldRequireAccountContext) {
      butlerSelection = resolveProductButlerSelection(productDetail.product);
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
    // 由基本信息 API 解析过程追加到 scenicSpotLogs，再在每轮结束时
    // 落盘到 automation log，便于人工核对。
    const keySpots = pickKeySpotsFromItinerary(productDetail.product);
    const scenicSpotLogs: string[] = [];

    if (retryFrom && !productDetail.automation) throw new Error("没有可重试的自动录入记录。");
    const run: AutomationRun = retryFrom
      ? productDetail.automation?.status === "queued"
        ? prepareQueuedPhaseResume(productDetail.automation, draftPhases, retryFrom)
        : preparePhaseRetry(productDetail.automation!, draftPhases, retryFrom)
      : { id: randomUUID(), status: "running", phases: draftPhases.map((phase) => ({ phase, status: "pending" })), logs: [] };
    const log = (message: string, level: "info" | "warning" | "error" = "info") => { run.logs.push({ at: new Date().toISOString(), message, level }); ctx.db.saveAutomation(localProductId, run); ctx.emit(localProductId); };
    const persist = () => { ctx.db.saveAutomation(localProductId, run); ctx.emit(localProductId); };
    ctx.db.saveAutomation(localProductId, run);
    if (normalizedProductType.changed) {
      log("旧产品类型已在创建远端草稿前归一为境内短途，避免缺少大交通卡片导致校验失败。", "warning");
    }
    ctx.db.updateProduct(localProductId, productDetail.product, "automating");
    try {
      const page = await ctx.browser.page();
      let productId = productDetail.productId;
      if (startIndex === 0) {
        initializeAutomationStartPhase(run, productId);
        if (!productId) {
          log("正在创建 VBK 产品草稿…");
          // configureProductShell 现在原子化完成销售控制（产品类型/形态/线路品牌
          // /分销渠道 + 点下一步），并返回携程产品 ID，不再单独调 createProductShell。
          productId = await ctx.runVbkPageExclusive(() => configureProductShellApi(page, product));
          ctx.db.setProductId(localProductId, productId);
          // configureProductShellApi 已完成销售控制远端回读；先持久化销售控制
          // 的完成态并推送 UI，之后才开始 basic，避免 API 直连模式下阶段状态
          // 落后于实际保存结果。
          completeVerifiedSaleControlPhase(run);
          persist();
          log(`销售控制已通过远端回读：${productId}`);
        } else {
          log("正在重跑 basic 阶段…", "warning");
        }
        if (!productId) throw new Error("产品 ID 缺失，无法继续后续阶段。");
        log(`产品基本信息阶段开始：${productId}`);
      } else {
        // 中间阶段重试复用当前登录会话，并用显式 productId 先进入对应模块页，
        // 再调用 API；不依赖上一轮遗留的编辑器 URL 或当前 tab。
        log(`已从 ${retryFrom} 阶段继续录入（将进入对应模块页面）`);
      }

      // 每个 phase 处理器共享一份 productId 闭包，并独立被 runPhaseWithRecovery 包裹。
      const phaseRecord = (phase: string) => {
        const index = draftPhases.indexOf(phase);
        if (index < 0) throw new Error(`未注册的阶段：${phase}`);
        run.currentPhase = phase;
        run.phases[index].status = "running";
        persist();
      };

      const executePhase = async (phase: string, executeApi: () => Promise<unknown>) => {
        phaseRecord(phase);
        return ctx.runVbkPageExclusive(async () => {
          return executeApiWithPhasePageSync({
            page,
            productId,
            phase,
            log,
            isPageVisible: () => ctx.browser.isVisible(),
            ensureBrowserHasBounds: ctx.ensureBrowserHasBounds,
            navigate: (url) => ctx.browser.navigate(url),
            executeApi,
          });
        });
      };

      const saveBasicInfo = async () => {
        const skipProductLine = productLineBlocked;
        if (skipProductLine) {
          log("产品线曾阻断基本信息，本次不提交产品线字段，其余信息继续保存。", "warning");
        }
        try {
          return await ensureBasicInfoApi(
            page,
            product,
            productId!,
            butlerSelection!,
            servicePhone,
            { skipProductLine },
          );
        } catch (error) {
          if (isProductLineResolutionError(error)) productLineBlocked = true;
          throw error;
        }
      };

      const basicExecute = async () => {
        return executePhase("basic", async () => {
        // runner 重试本阶段时清空 scenicSpotLogs，防止把上一轮未命中的景点
        // 单项重复记入 automation 日志。
        scenicSpotLogs.length = 0;
        const refreshedSupplierCode = refreshSupplierProductCodeForPlatformWrite(product, butlerSelection, productId);
        if (refreshedSupplierCode) {
          productDetail.product = product as unknown as Record<string, unknown>;
          ctx.db.updateProduct(localProductId, productDetail.product, "automating");
          const supplierCode = String((product.basicInfo as Record<string, unknown>).supplierProductCode);
          log(`供应商产品编号已按本次写入时间重算：${refreshedSupplierCode}`);
          if (basicInfoSaved) {
            const result = await saveBasicInfo();
            log(`地接社已${result.localTravelAgency.selection === "defaulted" ? "自动选择" : "确认"}：${result.localTravelAgency.name || "未命名"}（${result.localTravelAgency.id}）`);
            log(`供应商产品编号已通过基本信息 API 写入并完成回读：${supplierCode}`);
            return;
          }
        }
        const shouldRefill = shouldRefillBasicInfo({ productId, basicInfoSaved, product: productDetail.product });
        log(`basic 阶段开始（reason=${shouldRefill.reason}）`);
        if (!productId) throw new Error("产品 ID 缺失，无法继续后续阶段。");
        if (shouldRefill.reason === "complete") {
          log("basic 阶段已保存且产品数据完整，跳过重复填充");
          return;
        }
        const result = await saveBasicInfo();
        log(`地接社已${result.localTravelAgency.selection === "defaulted" ? "自动选择" : "确认"}：${result.localTravelAgency.name || "未命名"}（${result.localTravelAgency.id}）`);
        // 把景点未命中的单项沉淀到 automation 日志。
        for (const entry of scenicSpotLogs) log(entry, "warning");
        // 仅当 VBK API 保存并完成远端回读后置位，失败路径不会误标。
        ctx.db.setBasicInfoSaved(localProductId);
        basicInfoSaved = true;
        });
      };

      const handlers: Record<string, () => Promise<unknown>> = {
        presentation: () => executePhase("presentation", () =>
          fillPresentationWithSensitiveRewrite({ ctx, localProductId, page, product, productId: productId!, log })),
        itinerary: () => executePhase("itinerary", () =>
          fillItineraryWithSensitiveRewrite({
            ctx,
            localProductId,
            product,
            log,
            executeItinerary: () => fillItineraryDraftApi(page, product, {
              disambiguator: ctx.disambiguator,
              productId,
            }),
            dbUpdate: (id, updatedProduct, status) => ctx.db.updateProduct(id, updatedProduct, status),
          })),
        package: () => executePhase("package", () => ensurePackageApi(page, product, productId!)),
        pricingInventory: () => executePhase("pricingInventory", () => ensurePricingInventoryApi(page, product, productId!)),
        terms: () => executePhase("terms", () => fillAndSaveTerms(page, product, productId)),
        hotelResource: () => executePhase("hotelResource", () => ensureHotelResourceApi(page, product, productId!)),
        vehicleResource: () => executePhase("vehicleResource", () => ensureVehicleResourceApi(page, product, productId!)),
        preflight: () => executePhase("preflight", () => runProductPreflightApi(page, product, productId!)),
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
        const latestProductId = ctx.db.getProduct(localProductId)?.productId;
        return {
        run,
        phase,
        completedPhases: draftPhases.slice(0, phaseIndex),
        productIdExists: Boolean(latestProductId),
        basicInfoSaved,
        execute,
        advisor: ctx.advisor,
        applyAction: async (action, attempt) => {
          if (action === "wait_for_user") {
            throw new Error("applyAction 不应收到 wait_for_user");
          }
          // executePhase 在每个 attempt 的开头独占页面并进入目标模块。这里若再
          // 导航，会与紧接着的 executePhase.goto 竞争并中断前一个导航。
          recordPhaseRetry({ productId, phase, action, attempt, log });
        },
        log,
        persist,
        // 「停止」按钮会写进 cancellationRequested。recovery 在 attempt
        // 顶部检查；in-flight handler 不打断（Playwright click 跨进程无
        // 安全中断点，强制中断会让浏览器页面留下半成品状态）。
        shouldCancel: () => ctx.cancellationRequested.has(localProductId),
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
          ctx.db.updateProduct(localProductId, product as unknown as Record<string, unknown>, "blocked");
          persist();
          return;
        }
        if (basicOutcome.status === "cancelled") {
          ctx.markCancelled(localProductId, run, persist);
          return;
        }
      } else {
        log(`跳过 basic 阶段（已保存），从 ${retryFrom} 继续并进入对应模块页面`);
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
          ctx.db.updateProduct(localProductId, product as unknown as Record<string, unknown>, "blocked");
          persist();
          return;
        }
        if (outcome.status === "cancelled") {
          ctx.markCancelled(localProductId, run, persist);
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
      ctx.db.updateProduct(localProductId, product as unknown as Record<string, unknown>, "draft_saved");
      persist();
    } catch (error) {
      // 「停止」流程不应该被 catch 当作 failed —— stop() 已经把 run.status
      // 改为 cancelled 并 emit 过，这里只需清理 cancellationRequested 后
      // 静默返回，不要覆盖状态。
      if (error instanceof AutomationCancelledError) {
        ctx.cancellationRequested.delete(localProductId);
        return;
      }
      // handler 内部可能因为 stop 之外的其他原因抛错 —— 现有逻辑保持不变。
      run.status = "failed";
      const current = run.phases.find((phase: { phase: string; status: string }) => phase.phase === run.currentPhase);
      if (current && current.status !== "completed") current.status = "failed";
      log(error instanceof Error ? error.message : "自动录入发生未知错误", "error");
      ctx.db.updateProduct(localProductId, product as unknown as Record<string, unknown>, "blocked");
      persist();
      throw error;
    } finally {
      // 走完所有阶段后清理取消信号 —— 防止下一次 run 进来时拿到的 stale flag。
      ctx.cancellationRequested.delete(localProductId);
    }
  }
