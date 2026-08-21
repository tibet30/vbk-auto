import type {
  AccountFixedInfoFieldKey,
  AccountFixedInfoValue,
  PoiSuggestLogContext,
} from "../../shared/contracts.js";
import { VbkDatabase } from "../infrastructure/database/database.js";
import { productNotFound } from "../infrastructure/db-errors.js";
import { suggestPoi, suggestPoiDemo, suggestPoiDetailWithRawPayload } from "../infrastructure/poi-suggest.js";
import { listProviderContactCards } from "../infrastructure/butler-contacts.js";
import {
  isManualCoverStillPresent,
  listManualCoverMetas,
  readManualCover,
  searchCtripLibraryCoverImages,
  searchCtripLibraryCoverPlaces,
  uploadManualCover,
} from "../operations/cover-ipc.js";
import { assertDebugEnabled, assertTrustedSender } from "../infrastructure/ipc-sender.js";
import { secureIpcMain as ipcMain } from "../infrastructure/ipc-sender.js";
import type { MainIpcContext } from "./context.js";

export function registerBrowserAutomationIpc(context: MainIpcContext): void {
  const {
    db,
    withKnownVbkAccount,
    logPoiManualIpc,
    emitProductIfKnown,
    detectProviderIdInMain,
  } = context;
  ipcMain.handle("browser:login", () => context.browser.login());
  ipcMain.handle("browser:logout", () => context.browser.logout());
  ipcMain.handle("browser:status", async (_event, refresh?: boolean) => withKnownVbkAccount(await context.browser.status(Boolean(refresh))));
  ipcMain.handle("poi:suggest", async (_event, keyword: string) => suggestPoi(context.browser, String(keyword ?? "")));
  ipcMain.handle("poi:suggestDetail", async (_event, keyword: string, inputContext?: PoiSuggestLogContext) => {
    const query = String(keyword ?? "");
    const logContext = {
      localProductId: inputContext?.localProductId,
      dayIndex: inputContext?.dayIndex,
      spotIndex: inputContext?.spotIndex,
      title: inputContext?.title,
      keyword: query,
    };
    logPoiManualIpc("ipc_search_start", logContext);
    try {
      const result = await suggestPoiDetailWithRawPayload(context.browser, query, {
        destinationCity: inputContext?.destinationCity,
        province: inputContext?.province,
      });
      logPoiManualIpc("ipc_search_detail", {
        ...logContext,
        httpStatus: result.httpStatus,
        businessStatus: result.businessStatus,
        poiListCount: result.poiListCount,
        candidateCount: result.candidates.length,
        rawPayload: result.rawPayload,
      });
      if (!result.best) logPoiManualIpc("ipc_search_empty", { ...logContext, candidateCount: result.candidates.length });
      else logPoiManualIpc("ipc_search_success", {
        ...logContext,
        poiName: result.best.poiName,
        poiId: result.best.poiId,
        candidateCount: result.candidates.length,
      });
      const { rawPayload: _rawPayload, ...detail } = result;
      return detail;
    } catch (err) {
      logPoiManualIpc("ipc_search_failure", {
        ...logContext,
        errorMessage: err instanceof Error ? err.message : "VBK POI 查询失败",
      });
      throw err;
    }
  });
  ipcMain.handle("poi:suggestDemo", async (_event, keyword: string) => suggestPoiDemo(context.browser, String(keyword ?? "")));
  ipcMain.handle("browser:navigate", (_event, url: string) => context.browser.navigate(url));
  ipcMain.handle("browser:currentUrl", () => context.browser.currentUrl());
  ipcMain.handle("browser:openExternal", () => context.browser.openExternal());
  ipcMain.handle("browser:setBounds", (_event, bounds) => context.browser.setBounds(bounds));
  ipcMain.handle("browser:setVisible", (_event, visible: boolean) => context.browser.setVisible(visible));
  ipcMain.handle("browser:listLoginAccounts", () => context.browser.listKnownLoginAccounts());
  ipcMain.handle("browser:addLogin", () => context.browser.addLogin());
  ipcMain.handle("browser:switchAccount", (_event, accountKey: string) => context.browser.switchAccount(accountKey));
  ipcMain.handle("browser:forgetAccount", (_event, accountKey: string) => {
    context.browser.forgetAccount(accountKey);
    return { forgotten: true };
  });
  ipcMain.handle("automation:start", (_event, localProductId: string) =>
    context.productWorkflows.runExclusive(localProductId, "automation", () => context.automation.start(localProductId)));
  // 「停止」按钮的入口：立刻把 run 标记为 cancelled，runner 在下一个
  // checkpoint 跳出。不等待 Playwright 当前调用结束 ——
  // 跨进程 await click 安全中断点未知，强制 abort 可能让浏览器页面留下
  // 半成品 UI。让 in-flight handler 自然结束后下一 attempt 不再启动。
  ipcMain.handle("automation:stop", (_event, localProductId: string) => context.automation.stop(localProductId));
  // automation:retry 真正接到 preparePhaseRetry：如果产品当前的 automation
  // 已是 failed，则从 currentPhase / 最后失败阶段继续；否则退化为 start。
  // 先做一次窄恢复：旧版截图失败留下的「业务全成功 + run 标 failed + 产品 blocked」
  // 脏数据会因 failed phase 找不到而退化为 start（全量重跑错误）或被
  // retryPhase(preflight) 拒绝；本恢复按业务完成切回 succeeded + draft_saved。
  ipcMain.handle("automation:retry", (_event, localProductId: string) =>
    context.productWorkflows.runExclusive(localProductId, "automation", async () => {
    if (await context.automation.recoverLegacyScreenshotFalseFailure(localProductId)) return;
    const product = db.getProduct(localProductId);
    if (!product) throw productNotFound(localProductId);
    const failedPhase = product.automation?.recovery
      ? Object.values(product.automation.recovery.phases).find((rec) => rec.state === "needs_user")?.phase
      : product.automation?.phases.find((phase) => phase.status === "failed")?.phase;
    if (failedPhase) return context.automation.retryPhase(localProductId, failedPhase);
    return context.automation.start(localProductId);
  }));
  ipcMain.handle("automation:retryPhase", (_event, localProductId: string, phase: string) =>
    context.productWorkflows.runExclusive(localProductId, "automation", () => context.automation.retryPhase(localProductId, phase)));
  // 「重新执行」按钮的入口：单阶段重跑，不影响其他阶段。与 retryPhase
  // （失败后多阶段 forward）的区别：retryPhase 会重置后续阶段并从头跑
  // 到尾；retryOnePhase 只跑一个阶段，用于运营 review 当前页面填充效果。
  ipcMain.handle("automation:retryOnePhase", (_event, localProductId: string, phase: string) =>
    context.productWorkflows.runExclusive(localProductId, "automation", () => context.automation.retryOnePhase(localProductId, phase)));
  // 调试入口：仅 dev + VBK_DEBUG=1 时可访问。
  // 任何 IPC 调用都必须先 assertTrustedSender / assertDebugEnabled，避免
  // 外部 frame 触发逐步骤执行（极容易泄漏当前会话 cookies / 渲染文件）。
  ipcMain.handle("automation:debug:runStep", (event, stepName: string, argsJson: string) => {
    assertTrustedSender(event, "automation:debug:runStep");
    assertDebugEnabled("automation:debug:runStep");
    return context.automation.debugRunStep(stepName, argsJson);
  });
  ipcMain.handle("automation:debug:snapshot", (event, label?: string) => {
    assertTrustedSender(event, "automation:debug:snapshot");
    assertDebugEnabled("automation:debug:snapshot");
    return context.automation.debugSnapshot(label);
  });
  ipcMain.handle("automation:debug:hitBreakpoints", (event) => {
    assertTrustedSender(event, "automation:debug:hitBreakpoints");
    assertDebugEnabled("automation:debug:hitBreakpoints");
    return context.automation.debugHitBreakpoints();
  });
  ipcMain.handle("automation:debug:resume", (event, command: "continue" | "step" | "stop") => {
    assertTrustedSender(event, "automation:debug:resume");
    assertDebugEnabled("automation:debug:resume");
    return context.automation.debugResume(command);
  });
  ipcMain.handle("automation:debug:listBreakpoints", (event) => {
    assertTrustedSender(event, "automation:debug:listBreakpoints");
    assertDebugEnabled("automation:debug:listBreakpoints");
    return context.automation.debugListBreakpoints();
  });
  ipcMain.handle("accounts:getFixedInfo", (_event, accountName: string) => db.getAccountFixedInfo(accountName));
  ipcMain.handle("accounts:saveFixedInfo", (event, accountName: string, values: Partial<Record<AccountFixedInfoFieldKey, AccountFixedInfoValue | null>>) => {
    // 与 products:updateReviewField 对称：会改写「账号级固定信息」，对外来的
    // webContents 调用一律拒绝。同样的对称性也要求「accounts:getFixedInfo」
    // 之类的只读入口不需要 sender 校验。
    assertTrustedSender(event, "accounts:saveFixedInfo");
    const saved = db.setAccountFixedInfo(accountName, values);
    emitProductIfKnown(accountName, saved);
    return saved;
  });
  ipcMain.handle("accounts:fixedInfoSchema", () => VbkDatabase.fixedInfoSchema());
  ipcMain.handle("accounts:detectProviderId", () => detectProviderIdInMain());
  ipcMain.handle("accounts:currentProviderId", () => {
    const name = db.getSetting("vbkAccountName")?.value;
    return name ? db.providerIdFor(name) : null;
  });
  ipcMain.handle("accounts:listKnownAccounts", () => db.listKnownAccounts());
  ipcMain.handle("accounts:providerIdFor", (_event, accountName: string) => db.providerIdFor(accountName));
  ipcMain.handle("contacts:listProviderContactCards", async (_event, providerId: number, searchKeyword?: string) => {
    const page = await context.browser.page();
    return listProviderContactCards(page, providerId, searchKeyword);
  });
  ipcMain.handle("contacts:suggestPoi", async (_event, keyword: string) => {
    const query = typeof keyword === "string" ? keyword.trim() : "";
    if (!query) return null;
    return suggestPoi(context.browser, query);
  });
  // 产品封面：手动上传 + 携程图库候选查询。所有入口先做 trusted sender 校验。
  ipcMain.handle("cover:uploadManual", (event, args) => uploadManualCover(event, args));
  ipcMain.handle("cover:read", (event, args) => readManualCover(event, args));
  ipcMain.handle("cover:listManualCovers", (event) => listManualCoverMetas(event));
  ipcMain.handle("cover:exists", (event, args) => isManualCoverStillPresent(event, args));
  // 阶段 A：按景点名称查 suggestpoi.json → 地址 / 景点候选列表；
  // UI 在地址列表里选中一个后再走 cover:searchCtripLibraryImages。
  ipcMain.handle("cover:searchCtripLibraryPlaces", (event, args) => searchCtripLibraryCoverPlaces(event, args, context.browser));
  // 阶段 B：按已选 place 取该地址下的携程图库图片列表；
  // 链路：searchImage → getImageInfo（BrowserView 内联 fetch）。
  ipcMain.handle("cover:searchCtripLibraryImages", (event, args) => searchCtripLibraryCoverImages(event, args, context.browser));
}
