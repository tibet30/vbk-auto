import { randomUUID } from "node:crypto";
import { BrowserWindow } from "electron";
import {
  fillBasicInfo,
  configureProductShell, createProductShell, ensureHotelResource, ensureVehicleResource, fillAndSaveBasicInfo,
  fillAndSavePackage, fillAndSavePresentation, fillAndSaveTerms, fillAndSubmitPricingInventory,
  fillItineraryDraft, openProductEditor, runProductPreflight, saveScreenshot, selectStationAddress,
} from "./automation/ctrip.js";
import { automationBlockers, parseProduct, pickKeySpotsFromItinerary, shouldRefillBasicInfo } from "./automation/schema.js";
import type {
  AdvisorOutcome, AdvisorRequest, AutomationRun, ContactCardSelection, ProjectDetail,
} from "../shared/contracts.js";
import { VbkDatabase } from "./database.js";
import { VbkBrowser } from "./vbk-browser.js";
import { preparePhaseRetry } from "./automation/phase-retry.js";
import { runPhaseWithRecovery, type RecoveryContext } from "./automation/recovery.js";
import { breakpoint, getHitBreakpoints, listBreakpoints, resetBreakpoints, resume as resumeDebug, snapshot as snapshotDebug } from "./automation/debug.js";

function draftPhasesFor(product: ReturnType<typeof parseProduct>) {
  // 顺序对齐 VBK 页签：资源配置在条款维护之前。
  const phases = ["basic", "presentation", "itinerary", "package"];
  if (product.commercial?.pricing && product.commercial.inventory) phases.push("pricingInventory");
  if (product.itinerary.some((day) => Boolean(day.hotel))) phases.push("hotelResource");
  if (product.sales.productForm === "privateTour") phases.push("vehicleResource");
  const terms = product.commercial?.terms;
  if (terms?.inclusions && terms.exclusions && terms.bookingNotes && terms.refundPolicy) phases.push("terms");
  phases.push("preflight");
  return phases;
}

export class DraftAutomation {
  private running = new Set<string>();

  constructor(
    private db: VbkDatabase,
    private browser: VbkBrowser,
    private onUpdate: (project: ProjectDetail) => void,
    private advisor: (req: AdvisorRequest) => Promise<AdvisorOutcome>,
    private disambiguator?: (req: { kind: "province" | "city" | "spot" | "station"; desired: string; candidates: Array<{ id?: string; text: string }>; product: Record<string, unknown> }) => Promise<{ pickedText: string | null; reasoning: string }>,
  ) {}

  async start(projectId: string) {
    return this.runLocked(projectId);
  }

  /**
   * 调试入口：按名字调一个具名 ctrip 步骤，返回 JSON 可序列化结果。
   * 支持 step 列表在下方 if/else 里随时扩。argsJson 是 JSON 字符串，
   * CLI 侧不需要知道 TypeScript 类型。
   */
  async debugRunStep(stepName: string, argsJson: string): Promise<unknown> {
    resetBreakpoints();
    // debug 入口也走同样上 view 没上报 bounds 的兑底：保证 window.innerWidth
    // / innerHeight 是主窗口实际大小，否则 click 会超出 viewport。
    this.ensureBrowserHasBounds();
    const page = await this.browser.page();
    const args = argsJson ? (JSON.parse(argsJson) as Record<string, unknown>) : {};
    const cardSelector = typeof args.cardSelector === "string" ? args.cardSelector : null;
    if (stepName === "snapshot") {
      return snapshotDebug(page, typeof args.label === "string" ? args.label : "manual");
    }
    if (stepName === "selectStationAddress") {
      if (!cardSelector) throw new Error("selectStationAddress 需要 cardSelector 参数");
      const card = page.locator(cardSelector).first();
      const city = typeof args.city === "string" ? args.city : "大同";
      await breakpoint("beforeSelectStationAddress", { cardSelector, city });
      const result = await selectStationAddress(page, card, city) as unknown as { matched?: boolean; source?: string; reason?: string };
      await breakpoint("afterSelectStationAddress", { city });
      return { ok: result?.matched === true, city, source: result?.source || "unknown", reason: result?.reason || null };
    }
    if (stepName === "fillItineraryDraft") {
      const projectId = typeof args.projectId === "string" ? args.projectId : null;
      if (!projectId) throw new Error("fillItineraryDraft 需要 projectId 参数");
      const project = this.db.getProject(projectId);
      if (!project) throw new Error(`项目不存在：${projectId}`);
      const product = parseProduct(project.product);
      await breakpoint("beforeFillItineraryDraft");
      const result = await fillItineraryDraft(page, product, { productId: project.productId });
      await breakpoint("afterFillItineraryDraft", { savedWith: result.savedWith });
      return result;
    }
    if (stepName === "fillRecommendationReasons") {
      const projectId = typeof args.projectId === "string" ? args.projectId : null;
      if (!projectId) throw new Error("fillRecommendationReasons 需要 projectId 参数");
      const project = this.db.getProject(projectId);
      if (!project) throw new Error(`项目不存在：${projectId}`);
      const product = parseProduct(project.product);
      if (!product.presentation?.recommendations?.length) throw new Error("项目 presentation.recommendations 为空");
      await breakpoint("beforeFillRecommendationReasons");
      const { fillRecommendationReasons } = await import("./automation/ctrip.js");
      await fillRecommendationReasons(page, product.presentation.recommendations);
      await breakpoint("afterFillRecommendationReasons");
      return { rows: product.presentation.recommendations.length };
    }
    if (stepName === "fillBasicInfo" || stepName === "fillPresentation") {
      const projectId = typeof args.projectId === "string" ? args.projectId : null;
      if (!projectId) throw new Error(`${stepName} 需要 projectId 参数`);
      const project = this.db.getProject(projectId);
      if (!project) throw new Error(`项目不存在：${projectId}`);
      const product = parseProduct(project.product);
      const accountInfo = project.product && typeof (project.product as Record<string, unknown>).accountInfo === "object"
        ? (project.product as Record<string, unknown>).accountInfo as Record<string, unknown>
        : {};
      const butlerSelection = {
        contactCardId: Number(accountInfo?.butlerContactCardId) || 0,
        displayName: typeof accountInfo?.butlerContactName === "string" ? accountInfo.butlerContactName : "",
      };
      const extra = {
        servicePhone: typeof accountInfo?.servicePhone === "string" ? accountInfo.servicePhone : "",
        disambiguator: this.disambiguator,
        product,
      };
      if (stepName === "fillBasicInfo") {
        return await fillBasicInfo(page, product, butlerSelection, extra);
      }
      const { fillAndSavePresentation } = await import("./automation/ctrip.js");
      return await fillAndSavePresentation(page, product);
    }
    if (stepName === "fillAndSavePackage" || stepName === "fillAndSubmitPricingInventory" || stepName === "ensureHotelResource" || stepName === "ensureVehicleResource" || stepName === "runProductPreflight") {
      const projectId = typeof args.projectId === "string" ? args.projectId : null;
      if (!projectId) throw new Error(`${stepName} 需要 projectId 参数`);
      const project = this.db.getProject(projectId);
      if (!project) throw new Error(`项目不存在：${projectId}`);
      const product = parseProduct(project.product);
      const { fillAndSavePackage, fillAndSubmitPricingInventory, ensureHotelResource, ensureVehicleResource, runProductPreflight } = await import("./automation/ctrip.js");
      if (stepName === "fillAndSavePackage") {
        return await fillAndSavePackage(page, product);
      }
      if (stepName === "fillAndSubmitPricingInventory") {
        return await fillAndSubmitPricingInventory(page, product, project.productId || "");
      }
      if (stepName === "ensureHotelResource") {
        return await ensureHotelResource(page, product, project.productId || "");
      }
      if (stepName === "ensureVehicleResource") {
        return await ensureVehicleResource(page, product, project.productId || "");
      }
      if (stepName === "runProductPreflight") {
        return await runProductPreflight(page, product, project.productId || "");
      }
    }
    throw new Error(`未知步骤：${stepName}；支持：snapshot / selectStationAddress / fillItineraryDraft / fillRecommendationReasons / fillAndSavePackage / fillAndSubmitPricingInventory / ensureHotelResource / ensureVehicleResource / runProductPreflight`);
  }

  async debugSnapshot(label?: string): Promise<unknown> {
    // 调试快照也走兑底： renderer 不上 stage=vbk 时 view 还是 0×0，
    // 取主窗口 size 重设一下，否则后续 click 也会超出 viewport。
    this.ensureBrowserHasBounds();
    const page = await this.browser.page();
    return snapshotDebug(page, label);
  }

  async debugHitBreakpoints(): Promise<string[]> {
    return [...getHitBreakpoints()];
  }

  async debugResume(command: "continue" | "step" | "stop"): Promise<{ stopped: boolean }> {
    return resumeDebug(command);
  }

  async debugListBreakpoints(): Promise<string[]> {
    return listBreakpoints();
  }

  async retryPhase(projectId: string, phase: string) {
    const requested = typeof phase === "string" ? phase.trim() : "";
    if (!requested) throw new Error("请选择要重试的失败阶段。");
    return this.runLocked(projectId, requested);
  }

  private ensureBrowserHasBounds(): void {
    // 主窗口未构造时不存在 view，运行时直接 return。view 在 createWindow
    // 后期添加并由 renderer ResizeObserver 上报。
    const view = (this.browser as unknown as { view?: { getBounds?: () => Electron.Rectangle | null } } | null | undefined)?.view;
    if (!view || typeof view.getBounds !== "function") return;
    // 这里原本“view 宽高 > 0 就跳过”的逻辑会漏过 viewport 还是 0×0 的
    // 场景： renderer ResizeObserver 没被触发（用户还在 stage=ai，没
    // 切到 vbk），view 之前被设置过非零 bounds 但当前 webContents
    // 还是 0×0。直接走兑底 — 取主窗口 size 重新写一遍 bounds，能
    // 解决“跨越进程触发自动化时 view 实际为 0×0”的老 bug。
    const setBounds = (this.browser as unknown as { setBounds?: (b: { x: number; y: number; width: number; height: number }) => void } | null | undefined)?.setBounds;
    if (typeof setBounds !== "function") return;
    const wins = BrowserWindow.getAllWindows();
    const main = wins[0];
    if (!main) return;
    const [width, height] = main.getSize();
    if (width <= 0 || height <= 0) return;
    // view 在 invisible 时 viewport 是 0×0，setBounds 也不会让 webContents
    // 重新计算。先保证可见，再重设 bounds。
    this.browser!.setVisible?.(true);
    this.browser!.setBounds!({ x: 0, y: 0, width, height });
  }

  private async runLocked(projectId: string, retryFrom?: string) {
    // 同一项目并发录入会共用一个 Playwright 页面互相抢占，甚至创建出两个草稿。
    if (this.running.has(projectId)) throw new Error("该项目的自动录入正在进行中，请等待本轮结束。");
    this.running.add(projectId);
    try {
      await this.run(projectId, retryFrom);
    } finally {
      this.running.delete(projectId);
    }
  }

  /**
   * 读取当前 VBK 账号在本地保存的管家联系人；缺失或格式错误时返回 null。
   * 该数据由调用方在 basic 阶段直接传给 fillAndSaveBasicInfo，不再注入页面
   * 全局对象，避免把内部数据带进 VBK 页面上下文。
   */
  private resolveButlerSelection(accountName: string | undefined): ContactCardSelection | null {
    if (!accountName) return null;
    const info = this.db.getAccountFixedInfo(accountName);
    const butler = info.values.butlerName;
    return butler && typeof butler === "object" ? butler : null;
  }

  /**
   * 读取当前 VBK 账号在本地保存的 400 电话（servicePhone）。缺失或为空时
   * 返回 null，由 basic 阶段在 VBK 下拉里抛错，禁止默认第一项。
   */
  private resolveServicePhone(accountName: string | undefined): string | null {
    if (!accountName) return null;
    const info = this.db.getAccountFixedInfo(accountName);
    const phone = info.values.servicePhone;
    if (typeof phone !== "string") return null;
    const trimmed = phone.trim();
    return trimmed || null;
  }

  private async run(projectId: string, retryFrom?: string) {
    const project = this.db.getProject(projectId);
    if (!project) throw new Error("项目不存在");
    const product = parseProduct(project.product);
    // 触发前先决：让 VBK 视图可见并兑底 bounds。
    // 这些调用必须在后面任何预检查 / 阶段 runner 之前完成，否则：
    //   1) view 隐藏时 setVisible 没调，Playwright 连接后看到 window.innerHeight=0
    //   2) view 没填满窗口时 auto-scroll 跟不动，click 30s 超时
    //   3) 但预检查（管家 / 400 电话 / blockers）会在 view 还没就绪时抛错，
    //      把 ensureBrowserHasBounds 这一兑底短路掉。
    this.browser.setVisible(true);
    this.ensureBrowserHasBounds();
    // 后面几个阶段强制要求这些字段，但它们在 productSchema 里是可选的。
    // 必须在创建远程草稿之前拦下，否则会在携程留下一个半成品产品。
    const blockers = automationBlockers(project.product);
    if (blockers.length) {
      throw new Error(`录入前检查未通过：${blockers.map((item) => item.label).join("、")}`);
    }
    // 账号固定信息里的「管家联系人」是 basic 阶段实际依赖的来源；若账号
    // 尚未在本地维护管家联系人，必须在创建远程草稿之前阻断，避免留半成品
    // 草稿。地接社名称已不属于账号固定信息，由自动化在 VBK 当前页下拉里
    // 自动选择第一个可用且非 disabled 的选项。
    const draftPhases = draftPhasesFor(product);
    const startIndex = retryFrom ? draftPhases.indexOf(retryFrom) : 0;
    if (retryFrom && startIndex < 0) throw new Error(`当前产品没有阶段：${retryFrom}`);
    if (retryFrom && !project.productId) throw new Error("远程草稿尚未创建，不能从中间阶段重试。");

    const accountName = this.db.getSetting("vbkAccountName")?.value;
    // 任意阶段恢复前都重新幂等录入产品信息，因此同样需要管家联系人。
    // 这能修复历史任务把 basic 误标成功、但 VBK 实际仍未保存的情况。
    const butlerSelection = this.resolveButlerSelection(accountName);
    if (!accountName) throw new Error("未检测到当前登录的 VBK 账号，无法读取管家联系人。");
    if (!butlerSelection) throw new Error("录入前检查未通过：管家联系人（请在账号设置里维护）");
    // 线上 400 电话只来自账号固定信息，不进入产品 JSON。缺失时在操作远端
    // 页面之前阻断；进入 basic 后再按保存值精确匹配 VBK 下拉。
    const servicePhone = this.resolveServicePhone(accountName);
    if (!servicePhone) throw new Error("录入前检查未通过：线上 400 电话（请在账号设置里维护）");
    // 国家景区内具体景点：从行程中确定性筛选最多 3 个；不可匹配的单项
    // 由 fillAndSaveBasicInfo 内部追加到 scenicSpotLogs，再在每轮结束时
    // 落盘到 automation log，便于人工核对。
    const keySpots = pickKeySpotsFromItinerary(project.product, 3);
    const scenicSpotLogs: string[] = [];

    if (retryFrom && !project.automation) throw new Error("没有可重试的自动录入记录。");
    const run: AutomationRun = retryFrom
      ? preparePhaseRetry(project.automation!, draftPhases, retryFrom)
      : { id: randomUUID(), status: "running", phases: draftPhases.map((phase) => ({ phase, status: "pending" })), logs: [] };
    const log = (message: string, level: "info" | "warning" | "error" = "info") => { run.logs.push({ at: new Date().toISOString(), message, level }); this.db.saveAutomation(projectId, run); this.emit(projectId); };
    const persist = () => { this.db.saveAutomation(projectId, run); this.emit(projectId); };
    this.db.saveAutomation(projectId, run);
    this.db.updateProduct(projectId, project.product, "automating");
    // setVisible + ensureBrowserHasBounds 已在 run 入口提前调用，
    // 保证后面预检查 / 阶段 runner 不会因 view 未就绪拖崩 click。
    let basicInfoSaved = project.basicInfoSaved ?? false;
    try {
      const page = await this.browser.page();
      let productId = project.productId;
      if (startIndex === 0) {
        run.currentPhase = "basic"; run.phases[0].status = "running";
        if (!productId) {
          log("正在创建 VBK 产品草稿…");
          await configureProductShell(page, product);
          productId = (await createProductShell(page)) as string;
          this.db.setProductId(projectId, productId);
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
        if (!shouldRefill.refill && !productId) throw new Error("产品 ID 缺失，无法继续后续阶段。");
        await fillAndSaveBasicInfo(page, product, butlerSelection, { servicePhone, keySpots, scenicSpotLogs, disambiguator: this.disambiguator });
        // 把景点未命中的单项沉淀到 automation 日志。
        for (const entry of scenicSpotLogs) log(entry, "warning");
        // 仅当 VBK 真实保存成功后置位；setBasicInfoSaved 由 fillAndSaveBasicInfo
        // 通过 tab 解锁门禁间接验证，runner 不能因此前置。
        this.db.setBasicInfoSaved(projectId);
        basicInfoSaved = true;
        run.phases[0].status = "completed";
      };

      const handlers: Record<string, () => Promise<unknown>> = {
        presentation: async () => { phaseRecord("presentation"); const r = await fillAndSavePresentation(page, product); run.phases[draftPhases.indexOf("presentation")].status = "completed"; return r; },
        itinerary: async () => { phaseRecord("itinerary"); const r = await fillItineraryDraft(page, product, { disambiguator: this.disambiguator, productId }); run.phases[draftPhases.indexOf("itinerary")].status = "completed"; return r; },
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
            this.db.updateProduct(projectId, product as unknown as Record<string, unknown>, "automating");
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
        const latestProductId = this.db.getProject(projectId)?.productId;
        return {
        run,
        phase,
        completedPhases: draftPhases.slice(0, phaseIndex),
        productIdExists: Boolean(latestProductId),
        basicInfoSaved,
        execute,
        advisor: this.advisor,
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
          this.db.updateProduct(projectId, project.product, "blocked");
          persist();
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
          this.db.updateProduct(projectId, project.product, "blocked");
          persist();
          return;
        }
        log(`已保存：${phase}`);
      }
      run.status = "succeeded"; run.currentPhase = undefined; run.screenshot = await saveScreenshot(page, "desktop-draft", productId!);
      log("产品草稿已保存，未提交审核、未发布。", "warning"); this.db.updateProduct(projectId, product as unknown as Record<string, unknown>, "draft_saved"); persist();
    } catch (error) {
      run.status = "failed";
      const current = run.phases.find((phase) => phase.phase === run.currentPhase);
      if (current && current.status !== "completed") current.status = "failed";
      log(error instanceof Error ? error.message : "自动录入发生未知错误", "error");
      this.db.updateProduct(projectId, project.product, "blocked");
      persist();
      throw error;
    }
  }
  private emit(projectId: string) { const current = this.db.getProject(projectId); if (current) this.onUpdate(current); }
}
