/**
 * Electron main 进程入口。
 *
 * 主要职责：
 *  - 初始化数据层（VbkDatabase）、AI 服务、VBK 嵌入式浏览器、Automation；
 *  - 创建主窗口并绑定 IPC 路由（`registerIpc()`）；
 *  - 项目更新后向 renderer 推送 `project:updated` 事件；
 *  - 启动时恢复孤儿 automation run / planning state。
 *
 * 本文件已偏大（700+ 行）：拆分计划需与 Code Review 一起安排；本次只
 * 补文件头与少量 IPC 分组注释。
 */

import path from "node:path";
import { app, BrowserWindow, ipcMain } from "electron";
import { fileURLToPath } from "node:url";
import { VbkDatabase } from "./infrastructure/database/database.js";
import {
  MiniMaxService,
  MiniMaxServiceError,
  isCoverResearchTaskSatisfiedByProduct,
} from "./minimax/minimax.js";
import { applyProductPatchSafe } from "./operations/product-patch.js";
import { automationBlockers, parseProduct, productSchema } from "./automation/schema/schema.js";
import { VbkBrowser } from "./infrastructure/vbk-browser.js";
import { DraftAutomation } from "./automation/automation.js";
import { resolveVehicleResource } from "./operations/vehicle-resource.js";
import { resolveHotelResource } from "./operations/hotel-resource.js";
import { detectProviderIdFromBrowser, scheduleProviderIdRefresh } from "./infrastructure/provider-id-source.js";
import { listProviderContactCards } from "./infrastructure/butler-contacts.js";
import { applyManualReviewField } from "./operations/manual-review-field.js";
import { loadOperationLog } from "./operations/operation-log-store.js";
import type { AccountFixedInfoFieldKey, AccountFixedInfoValue, AiConnectionTestInput, AiModelListInput, AiProvider, CreateProjectInput, ManualReviewFieldInput, OperationLogQuery, ProjectDetail, ProjectReadiness, Settings, VbkLoginStatus } from "../shared/contracts.js";
import { isAiProvider } from "../shared/contracts.js";
import { aiProviderConfig } from "../shared/ai-provider-config.js";
import type { PlanningGenerationState, PlanningModule, PlanningRunResult } from "../shared/contracts.js";
import { runPlan } from "./planning/plan-orchestrator.js";
import { OpenAICompatiblePlannerAdapter } from "./planning/adapters/openai-compatible-adapter.js";
import { DbGenerationStateStore, DbOrchestratorRuntime } from "./planning/runtime.js";
import { buildPreflightFailureState } from "./planning/preflight-failure.js";
import {
  restoreProjectToPlanningForRetry,
  syncProjectStatusAfterFailure,
  syncProjectStatusAfterRunPlan,
} from "./planning/project-status-sync.js";
import { VbkDatabaseError, projectNotFound } from "./infrastructure/db-errors.js";
import {
  classifyMiniMaxError,
  extractMiniMaxFailureReason,
  normalizeFailureMessage,
  stripRetryHintTail,
  toRetryHint,
} from "./minimax/minimax-error-handling.js";
import { assertSafeAiServiceUrl, resolveAiConnectionInput, successfulAiConnectionTest } from "./infrastructure/ai-settings.js";
import { fetchAiModelList } from "./infrastructure/ai-models.js";
import { isAsyncEncryptionAvailable, persistApiKeyAsync, loadApiKeyAsync } from "./infrastructure/secure-storage.js";
import { aiProviderLabel as resolveAiProviderLabel } from "../shared/ai-provider-config.js";
import { APP_NAME } from "../shared/brand.js";

/** 项目根目录（指向 repository root），用来定位本地静态资源 / fixtures。 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
/** 当前是否为开发模式（未打包），用于开关 DevTools / 临时文件路径。 */
const isDev = !app.isPackaged;
// 自动化通过 CDP 驱动内嵌的 VBK 页面，端口必须开着；但固定的 9222 可被
// 本机任意进程预测并接管这个已登录会话，也会和其它 Chrome 实例抢占。
// 改为每次启动随机取一个端口，并只监听回环地址。
/** 随机生成回环调试端口（9300-9899）并仅监听 127.0.0.1：避免固定 9222 端口被本机其它进程劫持。 */
const debuggingPort = String(9300 + Math.floor(Math.random() * 600));
app.commandLine.appendSwitch("remote-debugging-port", debuggingPort);
app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");
/** MiniMax 默认 model：环境变量优先，否则用项目默认的「MiniMax-M3」。 */
const defaultMiniMaxModel = process.env.MINIMAX_MODEL?.trim() || "MiniMax-M3";

let window: BrowserWindow; let db: VbkDatabase; let browser: VbkBrowser; let automation: DraftAutomation;
// 关闭窗口后 AI 或自动化可能仍在运行，向已销毁的 webContents 发送会抛异常。
/**
 * 向 renderer 广播「项目更新」事件：
 *   - 关闭窗口后 webContents 可能销毁，因此先 isDestroyed 判定；
 *   - 这条事件供 UI 实时刷新项目详情 / 操作日志。
 */
const emitProject = (project: ProjectDetail) => {
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return;
  window.webContents.send("project:updated", project);
};
/**
 * 把 settings 表中的字段聚合成对外的 Settings 对象（含 hasKey 这类派生布尔）。
 * 当 db 里没值时回落到默认值；用于 UI 渲染 / IPC 拿 setting 时不必关心落库字段。
 */
const getSettings = (): Settings => ({
  aiProvider: isAiProvider(db.getSetting("aiProvider")?.value) ? db.getSetting("aiProvider")!.value as AiProvider : "minimax",
  minimaxBaseUrl: db.getSetting("minimaxBaseUrl")?.value || "https://api.minimaxi.com/v1",
  minimaxModel: db.getSetting("minimaxModel")?.value || defaultMiniMaxModel,
  deepseekBaseUrl: db.getSetting("deepseekBaseUrl")?.value || "https://api.evolink.ai/v1",
  deepseekModel: db.getSetting("deepseekModel")?.value || "deepseek-v4-flash",
  hasMiniMaxKey: Boolean(db.getSetting("minimaxApiKey")),
  hasDeepSeekKey: Boolean(db.getSetting("deepseekApiKey")),
  dataPath: app.getPath("userData"),
});
/**
 * 异步加载指定 provider 的真实 API Key：
 *   - 走 secure storage（操作系统级加密），避免明文落 settings 表；
 *   - provider 决定查 deepseekApiKey 还是 minimaxApiKey 字段。
 */
async function apiKey(provider: AiProvider = getSettings().aiProvider) {
  const settingName = provider === "deepseek" ? "deepseekApiKey" : "minimaxApiKey";
  return loadApiKeyAsync(db, settingName);
}
/**
 * 按当前 settings 构造 MiniMaxService：
 *   - provider=deepseek 时切到 Evolink baseUrl/model；
 *   - apiKey 通过 secure-storage 异步读取；
 *   - snapshot 可注入，用于在 IPC 上下文里使用「最新 settings」构造服务（避免双重读盘）。
 */
async function aiService(snapshot?: Settings) {
  const settings = snapshot ?? getSettings();
  const isDeepSeek = settings.aiProvider === "deepseek";
  return new MiniMaxService({
    apiKey: await apiKey(settings.aiProvider),
    baseUrl: isDeepSeek ? settings.deepseekBaseUrl : settings.minimaxBaseUrl,
    model: isDeepSeek ? settings.deepseekModel : settings.minimaxModel,
    provider: settings.aiProvider,
  });
}
/**
 * 在 VBK 已登录的前提下，把当前账号信息写回 settings + 触发 providerId 异步刷新：
 *   - 页面抓不到账号名时优先沿用本机上次记录，不再回退到某个固定值（避免错标）；
 *   - 登录完后开始异步 scheduleProviderIdRefresh，写到 settings(providerIdByAccount:<name>)。
 */
function withKnownVbkAccount(status: VbkLoginStatus): VbkLoginStatus {
  if (!status.loggedIn) return status;
  // 页面抓取不到账号名时只沿用本机上次记录，不再回退到某个固定账号：
  // 那会把当前登录者错标成别人，并写进本地设置长期生效。
  const accountName = status.accountName || db.getSetting("vbkAccountName")?.value || "";
  if (accountName) {
    db.setSetting("vbkAccountName", accountName);
    scheduleProviderIdRefresh(accountName, detectProviderIdFromBrowser, (id: number | null) => db.setProviderIdFor(accountName, id));
  }
  // 多账号登录：检测到已登录后立刻落快照与活动指针，避免"切走后再想切回来时
  // 没找到老 cookies"。登录过程的 cookies 是分批写入的，必须 await 异步
  // 的 set，否则 saveCurrentSession 可能抓到不完整快照。activity 指针与
  // vbkAccountName 不同：后者用于 providerId 缓存 / UI 头像缩写；
  // 前者用于 switchAccount 直接定位 cookies 表里的行。
  if (accountName) {
    const snapshotKey = accountName.trim();
    void browser?.saveCurrentSession().then((saved) => {
      if (saved) db.setSetting("vbkActiveAccountKey", saved.accountKey);
      else if (snapshotKey) db.setSetting("vbkActiveAccountKey", snapshotKey);
    }).catch(() => undefined);
  }
  const accounts = Array.from(new Set([...(status.accounts || []), accountName].filter(Boolean)));
  return { ...status, accountName, accounts };
}
/**
 * 计算项目 readiness：把项目当前状态、已保存自动化运行、是否阻塞等映射到对外的 ProjectReadiness。
 * 用于 UI 顶栏显示与 IPC 路由。
 */
function readiness(projectId: string): ProjectReadiness {
  const project = db.getProject(projectId); if (!project) throw projectNotFound(projectId);
  const issues: ProjectReadiness["issues"] = [];
  const parsed = productSchema.safeParse(project.product);
  if (!parsed.success) {
    for (const issue of parsed.error.issues.slice(0, 6)) issues.push({ label: issue.path.join(".") || "产品方案", detail: issue.message });
  }
  const unresolved = project.researchTasks.filter((task) =>
    task.state !== "confirmed" &&
    task.state !== "resolved" &&
    !isCoverResearchTaskSatisfiedByProduct(task, project.product),
  );
  for (const task of unresolved) issues.push({ label: task.label, detail: task.detail || "需要在 VBK 或公开来源完成核查" });
  // 与自动录入使用同一套要求，避免界面显示「可以录入」后才在携程失败。
  if (parsed.success) for (const blocker of automationBlockers(project.product)) issues.push(blocker);
  // 自动录入当前正在运行 / 已停止等待用户处理时，再列一条直达指引。
  if (project.automation?.recovery?.phases) {
    const blocked = Object.values(project.automation.recovery.phases).find((rec) => rec.state === "needs_user");
    if (blocked) issues.push({
      label: "自动录入已停止",
      detail: blocked.userInstruction || "请先按提示手动处理后再次保存草稿",
    });
  }
  return { ready: issues.length === 0, completion: Math.round((Math.max(0, 12 - Math.min(12, issues.length)) / 12) * 100), issues };
}

/**
 * 创建主窗口并加载 renderer 入口；遵循 isDev 决定是否打开 DevTools。
 * 调用 registerIpc() 在窗口出现之前就注册好，避免 renderer 提前触发未注册 handler。
 */
async function createWindow() {
  window = new BrowserWindow({ width: 1512, height: 982, minWidth: 1180, minHeight: 760, title: APP_NAME, backgroundColor: "#fafafa", webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: path.join(root, "dist-electron", "main", "preload.cjs") } });
  if (isDev) await window.loadURL("http://127.0.0.1:5173"); else await window.loadFile(path.join(root, "dist", "index.html"));
  browser = new VbkBrowser(window, debuggingPort, {
    saveSession: (key, name, cookiesJson) => db.saveSession(key, name, cookiesJson),
    loadSession: (key) => db.loadSession(key),
    listSessions: () => db.listSessions(),
    deleteSession: (key) => db.deleteSession(key),
    getActiveAccountKey: () => db.getSetting("vbkActiveAccountKey")?.value,
    setActiveAccountKey: (key) => db.setSetting("vbkActiveAccountKey", key),
    clearActiveAccountKey: () => db.deleteSetting("vbkActiveAccountKey"),
  }); await browser.initialise();
  automation = new DraftAutomation(db, browser, emitProject, async (req) => {
    const settings = getSettings();
      const service = await aiService();
      try {
        return await service.diagnoseAutomationFailure(req);
    } catch (error) {
      console.warn("[recovery] advisor failed", {
        phase: req.phase,
        attempt: req.attempt,
        errorCode: (error as { code?: string }).code,
      });
      // 让 runner 把 advisor 抛错当 needs_user 处理：再抛出一次即可。
      throw error;
    }
  }, async (req) => {
    const settings = getSettings();
      const service = await aiService();
      try {
        return await service.disambiguateOption(req);
    } catch (error) {
      console.warn("[disambiguator] failed", {
        kind: req.kind,
        desired: req.desired,
        errorCode: (error as { code?: string }).code,
      });
      throw error;
    }
  });
}

/**
 * 注册全部 ipcMain.handle：
 *   - 项目相关：CRUD / readiness / applyProductPatchSafe / vehicle / hotel resolve 等；
 *   - AI 相关：connectionTest / fetchAiModelList / saveApiKey / planner run / advisor；
 *   - VBK 浏览器相关：getCurrentUserInfo / saveCurrentSession / switchAccount / forgetAccount。
 * 单文件较长，未来拆分计划与 code review 一起做。
 */
function registerIpc() {
  ipcMain.handle("projects:list", () => db.listProjects());
  ipcMain.handle("projects:create", (_event, input: CreateProjectInput) => {
    const project = db.createProject(input);
    emitProject(project);
    // 第一版产品方案的自动触发不在 main 这里走 —— 交给 renderer 端的 useEffect
    // 兑底。main 端 fire-and-forget 的请求与 renderer useEffect 重复触发会同时
    // 生成两条 user-running 消息，状态不一致；renderer 单一入口更可控，
    // 且能同时覆盖“新建后立即触发”与“重开空草稿项目”两种场景。
    return project;
  });
  ipcMain.handle("projects:get", (_event, id: string) => {
    const project = db.getProject(id);
    if (!project) throw projectNotFound(id);
    return project;
  });
  ipcMain.handle("projects:delete", (_event, id: string) => {
    const removed = db.deleteProject(id);
    if (!removed) throw projectNotFound(id);
    return { deleted: true };
  });
  ipcMain.handle("projects:readiness", (_event, id: string) => readiness(id));
  ipcMain.handle("projects:updateProductJson", (_event, id: string, json: string) => {
    const project = db.getProject(id);
    if (!project) throw projectNotFound(id);
    let next: Record<string, unknown>;
    try { next = JSON.parse(json); }
    catch { throw new Error("产品 JSON 无法解析，请检查格式。"); }
    parseProduct(next);
    db.updateProduct(id, next, "review");
    emitProject(db.getProject(id)!);
    return db.getProject(id)!;
  });
  // 运营人员直接在 UI 上录入的「需要人工复核」字段（例如定价 pricing）。
  // 仅允许 ManualReviewFieldInput 白名单，product 走 schema 校验后才落库；
  // 路径不走 JSON patch，避免与 AI 写入口径混在一起难以追溯。
  ipcMain.handle("projects:updateReviewField", (_event, id: string, input: ManualReviewFieldInput) => {
    const project = db.getProject(id);
    if (!project) throw projectNotFound(id);
    const next = applyManualReviewField(project.product, input);
    parseProduct(next);
    db.updateProduct(id, next, "review");
    emitProject(db.getProject(id)!);
    return db.getProject(id)!;
  });
  // 抽到模块级函数，projects:create 会用它做自动触发；调用方决定是否 fire-and-forget。
  // 这里不去做任何"是否第一次"判断 —— 自动触发由调用方按 minimax 已配置 API Key 决定。

  /** 检查产品草稿中是否缺失关键生成模块，返回缺失模块的路径列表。 */
  function detectMissingModules(product: Record<string, unknown>): string[] {
    const missing: string[] = [];
    const p = product.presentation;
    if (!p || typeof p !== "object" || Array.isArray(p)) missing.push("presentation");
    const i = product.itinerary;
    if (!Array.isArray(i) || i.length === 0) missing.push("itinerary");
    const c = product.commercial as Record<string, unknown> | undefined;
    if (!c || typeof c.pricing !== "object" || Array.isArray(c.pricing)) missing.push("commercial/pricing");
    if (!c || typeof c.inventory !== "object" || Array.isArray(c.inventory)) missing.push("commercial/inventory");
    if (!c || typeof c.release !== "object" || Array.isArray(c.release)) missing.push("commercial/release");
    if (!c || typeof c.terms !== "object" || Array.isArray(c.terms)) missing.push("commercial/terms");
    return missing;
  }

  async function runAiReply(projectId: string, content: string) {
    const project = db.getProject(projectId); if (!project) throw projectNotFound(projectId);
    const message = typeof content === "string" ? content.trim() : "";
    if (!message) throw new Error("请输入要发送给 AI 的内容。");
    if (message.length > 6000) throw new Error("单条消息不能超过 6000 个字符，请拆分后发送。");
    const userMessageId = db.addMessage(projectId, "user", message, "running");
    emitProject(db.getProject(projectId)!);
    // 本轮请求开始时锁定当前 AI 提供商快照：service、过程日志、最终 normalizeFailureMessage
    // 都使用同一份快照，避免请求过程中用户切换模型导致错误归错提供商。
    const turnSettings = getSettings();
    const providerLabel = resolveAiProviderLabel(turnSettings);
    try {
      const history = project.messages.filter((item) => (item.role === "user" || item.role === "assistant") && item.taskStatus !== "failed" && item.taskStatus !== "running");
      const service = await aiService(turnSettings);
      const itinerary = Array.isArray(project.product.itinerary) ? project.product.itinerary : [];
      const isInitialDraft = !itinerary.length && /生成|第一版|方案/.test(message);
      const retryableCodes = new Set(["provider_connection", "provider_timeout", "provider_error", "provider_rate_limit", "invalid_model_output", "empty_model_output"]);
      const isRetryable = (error: unknown) => {
        const code = classifyMiniMaxError(error);
        return retryableCodes.has(code);
      };
      const maxRetryAttempts = 5;
      let connectionChecked = false;
      const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
      let response: Awaited<ReturnType<MiniMaxService["reply"]>> | undefined;
      const repairPrompt = "上一次返回未通过结构化校验，请只返回纯 JSON 对象（仅包含 reply、patch、questions、researchTasks 四个字段），并为该轮返回至少一个可写入的 patch；不得带说明文字。";
      let lastFailureReason = "";
      const trimmedHistory = history.slice(-12);
      const requiresWritablePatch =
        isInitialDraft
        || /继续|补齐|补充|调整|更新|继续生成|继续补充|再次生成|重试|生成/.test(message)
        || /修正|重写|优化|重新/.test(message)
        || message.includes("上一次返回未通过结构化校验");
      for (let attempt = 1; attempt <= maxRetryAttempts; attempt++) {
        if (!connectionChecked) {
          await service.testConnection();
          connectionChecked = true;
        }
        const requestMessage = attempt === 1
          ? message
          : [
            message,
            repairPrompt,
            lastFailureReason ? `上一次返回原因：${lastFailureReason}` : "",
          ]
            .filter((item) => item)
            .join("\n\n");
        const attemptHistory = attempt === 1 ? trimmedHistory : trimmedHistory.slice(-4);
        try {
          response = await service.reply({
            message: requestMessage,
            product: project.product,
            history: attemptHistory.map((item) => ({ role: item.role, content: item.content })),
          });
          break;
          } catch (error) {
          if (attempt >= maxRetryAttempts || !isRetryable(error)) throw error;
          lastFailureReason = toRetryHint(extractMiniMaxFailureReason(error) || ((error as { message?: string })?.message ?? ""));
          try {
            const retryCode = classifyMiniMaxError(error);
            const shouldProbeConnectivity = new Set(["provider_connection", "provider_timeout", "provider_error"]).has(retryCode);
            if (shouldProbeConnectivity) {
              connectionChecked = false;
              console.warn("[AI] planning request failed, run connectivity check before retry", {
                provider: turnSettings.aiProvider,
                attempt,
                errorCode: (error as { code?: string })?.code,
              });
            }
          } catch (probeError) {
            throw probeError;
          }
          await wait(350 * attempt);
        }
      }
      // 如果服务返回空响应兜底，统一按结构化内容异常处理，避免错误地提示网络故障。
      if (!response) {
        throw new MiniMaxServiceError("invalid_model_output", "AI 未返回可写入的产品方案，请重试。");
      }
      const responsePatch = response.patch ?? [];
      const patchResult = responsePatch.length ? applyProductPatchSafe(project.product, responsePatch) : { product: project.product, applied: false };
      const next = patchResult.product;
      if (requiresWritablePatch && (responsePatch.length === 0 || !patchResult.applied)) {
        throw new MiniMaxServiceError("invalid_model_output", "AI 未返回可写入的产品方案，请重试。");
      }
      db.updateProduct(projectId, next); db.updateMessageStatus(projectId, userMessageId, "succeeded"); db.addMessage(projectId, "assistant", response.reply, "succeeded");
      for (const task of response.researchTasks || []) db.addResearchTask(projectId, task);
      // 首轮生成后自动检查缺失模块：如果 presentation / itinerary / commercial 子模块
      // 仍未写入，追加一轮 AI 调用专门补齐，提升首次生成完整率。
      if (isInitialDraft) {
        const currentProduct = db.getProject(projectId)!.product;
        const missingModules = detectMissingModules(currentProduct);
        if (missingModules.length > 0) {
          const missingHint = missingModules.join("、");
          console.info("[AI] first-draft missing modules detected, automatic follow-up", { provider: turnSettings.aiProvider, missingHint });
          const followUpMsg = `以下模块尚未生成：${missingHint}。请通过 submit_product_update 工具逐个补充这些模块的完整内容，每个模块用独立的 patch 操作。`;
          try {
            const secondResponse = await service.reply({
              message: followUpMsg,
              product: currentProduct,
              history: trimmedHistory.slice(-6).map((item) => ({ role: item.role as "user" | "assistant", content: item.content })),
            });
            const secondPatch = secondResponse.patch ?? [];
            if (secondPatch.length > 0) {
              const secondResult = applyProductPatchSafe(currentProduct, secondPatch);
              db.updateProduct(projectId, secondResult.product);
            }
            for (const task of secondResponse.researchTasks || []) {
              db.addResearchTask(projectId, task);
            }
          } catch (e) {
            // 补齐失败不抛错：第一轮产物已经可用（只是不全），用户仍然可以在左侧继续对话补齐。
            console.warn("[AI] completeness follow-up failed, keeping partial draft", { provider: turnSettings.aiProvider, error: (e as { message?: string })?.message ?? "unknown" });
          }
        }
        // 首轮生成后自动补齐 VBK 车辆和酒店资源：如果 VBK 已登录，通过 API
        // 搜索资源库匹配资源组/酒店，自动标记对应的核查任务为已解决。
        if (isInitialDraft) {
          try {
            const status = await browser.status();
            if (!status.loggedIn) {
              console.info("[AI] VBK not logged in, skipping auto resource resolution", { provider: getSettings().aiProvider });
            } else {
              const projectAfterAi = db.getProject(projectId)!;
              let page: ReturnType<typeof browser.page> | undefined;
              // 懒加载 VBK 页面：只在需要时才获取，避免过早消费 CDP 连接。
              const ensurePage = async () => { if (!page) page = browser.page(); return page; };
              // 车辆资源
              if (projectAfterAi.researchTasks.some((t) => t.state !== "confirmed" && t.state !== "resolved" && /用车|车辆|资源组|接送|司机/.test(t.label || ""))) {
                try {
                  const vehicleResult = await resolveVehicleResource(await ensurePage(), projectAfterAi);
                  db.updateProduct(projectId, vehicleResult.product, "review");
                  if (vehicleResult.resolved) {
                    for (const task of projectAfterAi.researchTasks) {
                      if (task.state !== "confirmed" && task.state !== "resolved" && /用车|车辆|资源组|接送|司机/.test(task.label || "")) {
                        db.markResearchAccepted(projectId, task.id, vehicleResult.note, "vbk");
                      }
                    }
                    console.info("[AI] auto vehicle resource resolved", { provider: getSettings().aiProvider, resourceGroupId: vehicleResult.resolved.resourceGroupId });
                  } else {
                    console.warn("[AI] vehicle resource not found in VBK", { provider: getSettings().aiProvider, note: vehicleResult.note });
                  }
                } catch (e) {
                  console.warn("[AI] auto vehicle resource resolution failed", { provider: getSettings().aiProvider, error: (e as { message?: string })?.message ?? "unknown" });
                }
              }
              // 酒店资源
              if (projectAfterAi.researchTasks.some((t) => t.state !== "confirmed" && t.state !== "resolved" && /酒店|住宿|客栈|民宿/.test(t.label || ""))) {
                try {
                  const hotelResult = await resolveHotelResource(await ensurePage(), projectAfterAi);
                  db.updateProduct(projectId, hotelResult.product, "review");
                  if (hotelResult.resolved && hotelResult.resolved.source === "vbk") {
                    for (const task of projectAfterAi.researchTasks) {
                      if (task.state !== "confirmed" && task.state !== "resolved" && /酒店|住宿|客栈|民宿/.test(task.label || "")) {
                        db.markResearchAccepted(projectId, task.id, hotelResult.note, "vbk");
                      }
                    }
                    console.info("[AI] auto hotel resource resolved", { provider: getSettings().aiProvider, resourceId: hotelResult.resolved.resourceId });
                  } else {
                    console.warn("[AI] hotel resource not found in VBK", { provider: getSettings().aiProvider, note: hotelResult.note });
                  }
                } catch (e) {
                  console.warn("[AI] auto hotel resource resolution failed", { provider: getSettings().aiProvider, error: (e as { message?: string })?.message ?? "unknown" });
                }
              }
            }
          } catch (e) {
            // 浏览器未就绪，静默跳过。
            console.info("[AI] browser not ready for auto resource resolution, skipping", { provider: getSettings().aiProvider });
          }
        }
      }
    } catch (error) {
      const reason = extractMiniMaxFailureReason(error) || (error instanceof Error ? error.message : "AI 服务暂时无法完成本次请求。");
      const errorCode = classifyMiniMaxError(error);
      const finalMessage = normalizeFailureMessage(errorCode, reason, providerLabel);
      const finalStructuredMessage = /返回的数据格式无法用于产品方案|MiniMax 返回的数据格式无法用于产品方案/i.test(finalMessage)
        ? stripRetryHintTail(finalMessage)
        : finalMessage;
      db.updateMessageStatus(projectId, userMessageId, "failed");
      db.addMessage(projectId, "assistant", `本轮没有获得 AI 回复：${finalStructuredMessage}`, "failed");
    }
    emitProject(db.getProject(projectId)!);
  }
  ipcMain.handle("ai:send", (_event, projectId: string, content: string) => runAiReply(projectId, content));
  ipcMain.handle("ai:regenerate", (_event, projectId: string, field: string) => {
    // 当前 renderer 未调用；保留入口以便运营后期手动触发单字段重生成。
    // 实际重新生成流程仍走 ai:send（运营填写一句自然语言指令 + 上下文），
    // 单独的实现不增加模型 prompt 重复，等有明确需求再补。
    void projectId; void field;
    throw new Error("AI 字段级重新生成尚未发布，请回到对话面板继续沟通。");
  });
  ipcMain.handle("research:accept", (_event, projectId: string, taskId: string, note?: string) => {
    db.markResearchAccepted(projectId, taskId, note);
    emitProject(db.getProject(projectId)!);
    return { accepted: true };
  });
  ipcMain.handle("research:vehicleResource", async (_event, projectId: string, taskId?: string) => {
    const project = db.getProject(projectId); if (!project) throw projectNotFound(projectId);
    const page = await browser.page();
    const result = await resolveVehicleResource(page, project);
    db.updateProduct(projectId, result.product, "review");
    if (taskId) db.markResearchAccepted(projectId, taskId, result.note, "vbk");
    db.addMessage(projectId, "assistant", `已完成用车估算和 VBK 资源组匹配：${result.note}`, "succeeded");
    const next = db.getProject(projectId)!;
    emitProject(next);
    return result.resolved;
  });
  ipcMain.handle("research:hotelResource", async (_event, projectId: string, taskId?: string) => {
    const project = db.getProject(projectId); if (!project) throw projectNotFound(projectId);
    const page = await browser.page();
    const result = await resolveHotelResource(page, project);
    db.updateProduct(projectId, result.product, "review");
    if (taskId) db.markResearchAccepted(projectId, taskId, result.note, "vbk");
    db.addMessage(projectId, "assistant", `已查询酒店资源：${result.note}`, "succeeded");
    emitProject(db.getProject(projectId)!);
    return result.resolved;
  });
  ipcMain.handle("research:previewVehicleResourceByPrice", async (_event, projectId: string, dailyCost: number) => {
    // 当前 UI 未实现价格预算 → 资源组匹配；保留 channel 以便合同稳定。
    void projectId; void dailyCost;
    throw new Error("按价格预算匹配资源组尚未发布，请先在 VBK 资源库手动核查。");
  });
  ipcMain.handle("research:confirmVehicleResourcePreview", async (_event, projectId: string, previewId: string) => {
    void projectId; void previewId;
    throw new Error("资源组预览确认尚未发布，请改用 research:vehicleResource。");
  });
  ipcMain.handle("browser:login", () => browser.login());
  ipcMain.handle("browser:logout", () => browser.logout());
  ipcMain.handle("browser:status", async (_event, refresh?: boolean) => withKnownVbkAccount(await browser.status(Boolean(refresh))));
  ipcMain.handle("browser:navigate", (_event, url: string) => browser.navigate(url));
  ipcMain.handle("browser:currentUrl", () => browser.currentUrl());
  ipcMain.handle("browser:openExternal", () => browser.openExternal());
  ipcMain.handle("browser:setBounds", (_event, bounds) => browser.setBounds(bounds));
  ipcMain.handle("browser:setVisible", (_event, visible: boolean) => browser.setVisible(visible));
  ipcMain.handle("browser:listLoginAccounts", () => browser.listKnownLoginAccounts());
  ipcMain.handle("browser:addLogin", () => browser.addLogin());
  ipcMain.handle("browser:switchAccount", (_event, accountKey: string) => browser.switchAccount(accountKey));
  ipcMain.handle("browser:forgetAccount", (_event, accountKey: string) => {
    browser.forgetAccount(accountKey);
    return { forgotten: true };
  });
  ipcMain.handle("automation:start", (_event, projectId: string) => automation.start(projectId));
  // 「停止」按钮的入口：立刻把 run 标记为 cancelled，runner 在下一个
  // checkpoint 跳出。不等待 Playwright 当前调用结束 ——
  // 跨进程 await click 安全中断点未知，强制 abort 可能让浏览器页面留下
  // 半成品 UI。让 in-flight handler 自然结束后下一 attempt 不再启动。
  ipcMain.handle("automation:stop", (_event, projectId: string) => automation.stop(projectId));
  // automation:retry 真正接到 preparePhaseRetry：如果项目当前的 automation
  // 已是 failed，则从 currentPhase / 最后失败阶段继续；否则退化为 start。
  ipcMain.handle("automation:retry", async (_event, projectId: string) => {
    const project = db.getProject(projectId);
    if (!project) throw projectNotFound(projectId);
    const failedPhase = project.automation?.recovery
      ? Object.values(project.automation.recovery.phases).find((rec) => rec.state === "needs_user")?.phase
      : project.automation?.phases.find((phase) => phase.status === "failed")?.phase;
    if (failedPhase) return automation.retryPhase(projectId, failedPhase);
    return automation.start(projectId);
  });
  ipcMain.handle("automation:retryPhase", (_event, projectId: string, phase: string) => automation.retryPhase(projectId, phase));
  // 「重新执行」按钮的入口：单阶段重跑，不影响其他阶段。与 retryPhase
  // （失败后多阶段 forward）的区别：retryPhase 会重置后续阶段并从头跑
  // 到尾；retryOnePhase 只跑一个阶段，用于运营 review 当前页面填充效果。
  ipcMain.handle("automation:retryOnePhase", (_event, projectId: string, phase: string) => automation.retryOnePhase(projectId, phase));
  // 调试入口：CLI / IDE 可以逐函数调用 ctrip.ts 并观察页面快照。
  // 启用方式：设置环境变量 VBK_DEBUG=1 重启 Electron。
  ipcMain.handle("automation:debug:runStep", (_event, stepName: string, argsJson: string) => automation.debugRunStep(stepName, argsJson));
  ipcMain.handle("automation:debug:snapshot", (_event, label?: string) => automation.debugSnapshot(label));
  ipcMain.handle("automation:debug:hitBreakpoints", () => automation.debugHitBreakpoints());
  ipcMain.handle("automation:debug:resume", (_event, command: "continue" | "step" | "stop") => automation.debugResume(command));
  ipcMain.handle("automation:debug:listBreakpoints", () => automation.debugListBreakpoints());
  ipcMain.handle("accounts:getFixedInfo", (_event, accountName: string) => db.getAccountFixedInfo(accountName));
  ipcMain.handle("accounts:saveFixedInfo", (_event, accountName: string, values: Partial<Record<AccountFixedInfoFieldKey, AccountFixedInfoValue | null>>) => {
    const saved = db.setAccountFixedInfo(accountName, values);
    emitProjectIfKnown(accountName, saved);
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
    const page = await browser.page();
    return listProviderContactCards(page, providerId, searchKeyword);
  });
  ipcMain.handle("settings:get", () => getSettings());
  ipcMain.handle("settings:getApiKey", async (_event, provider: unknown) => {
    if (!isAiProvider(provider)) throw new Error("不支持的 AI 提供商。");
    return apiKey(provider);
  });
  ipcMain.handle("settings:listModels", (_event, input: AiModelListInput) => fetchAiModelList(input, (provider) => apiKey(provider)));
  ipcMain.handle("settings:save", async (_event, input: Partial<Settings> & { apiKey?: string; deepseekApiKey?: string }) => {
    const provider = input.aiProvider;
    if (provider !== undefined && !isAiProvider(provider)) throw new Error("不支持的 AI 提供商。");

    const minimaxBaseUrl = input.minimaxBaseUrl?.trim();
    if (minimaxBaseUrl !== undefined) assertSafeAiServiceUrl(minimaxBaseUrl);
    const minimaxModel = input.minimaxModel?.trim();
    if (minimaxModel !== undefined && !minimaxModel) throw new Error("请填写 MiniMax 模型名。");
    const deepseekBaseUrl = input.deepseekBaseUrl?.trim();
    if (deepseekBaseUrl !== undefined) assertSafeAiServiceUrl(deepseekBaseUrl);
    const deepseekModel = input.deepseekModel?.trim();
    if (deepseekModel !== undefined && !deepseekModel) throw new Error("请选择 Evolink 模型。");

    const minimaxKey = input.apiKey?.trim();
    const deepseekKey = input.deepseekApiKey?.trim();
    if ((minimaxKey || deepseekKey) && !(await isAsyncEncryptionAvailable())) throw new Error("当前 macOS 无法加密保存密钥");
    if (provider === "minimax" && !minimaxKey && !db.getSetting("minimaxApiKey")) throw new Error("请填写 MiniMax API Key。");
    if (provider === "deepseek" && !deepseekKey && !db.getSetting("deepseekApiKey")) throw new Error("请填写 Evolink API Key。");

    if (minimaxBaseUrl !== undefined) db.setSetting("minimaxBaseUrl", minimaxBaseUrl);
    if (minimaxModel !== undefined) db.setSetting("minimaxModel", minimaxModel);
    if (minimaxKey) await persistApiKeyAsync(db, "minimaxApiKey", minimaxKey);
    if (deepseekBaseUrl !== undefined) db.setSetting("deepseekBaseUrl", deepseekBaseUrl);
    if (deepseekModel !== undefined) db.setSetting("deepseekModel", deepseekModel);
    if (deepseekKey) await persistApiKeyAsync(db, "deepseekApiKey", deepseekKey);
    // 当前模型最后切换，避免前面任一字段校验失败时留下半切换状态。
    if (provider !== undefined) db.setSetting("aiProvider", provider);
    return getSettings();
  });
  ipcMain.handle("settings:test", async (_event, input: AiConnectionTestInput) => {
    const resolved = await resolveAiConnectionInput(input, (provider) => apiKey(provider));
    await new MiniMaxService(resolved).testConnection();
    return successfulAiConnectionTest(resolved);
  });
  // 读取自动化操作历史。早期版本返回内存样例，等真实写入路径就绪后再
  // 改读持久化文件；查询语义保持一致以免上层调用方重写。
  ipcMain.handle("operationLog:load", (_event, query?: OperationLogQuery) => loadOperationLog(query));

  // 规划子系统接线：preflight + runPlan + 项目状态同步。所有 plan 层逻辑
  // 都被抽到 src/main/planning/*，main.ts 只做"装配 + 持久化 + 广播"。

  /** preflight / runPlan 抛错时的统一出口：把任意 error 包成 status=failed 的
   *  持久化 state，若项目存在则写 taskStatus='failed' 的 assistant 消息 + 同步
   *  projects.status + emitProject，返回给上层一个 status='failed' 的正常
   *  PlanningRunResult。
   *
   *  项目不存在时：仍持久化 failed state 并返回失败结果，但跳过 addMessage /
   *  syncProjectStatusAfterFailure / emitProject —— 否则消息表会出现孤儿
   *  project_id 行，破坏 conversations 反查项目的语义一致性。 */
  function handlePreflightFailure(projectId: string, error: unknown): PlanningRunResult {
    const project = db.getProject(projectId);
    const existing = db.loadPlanningState(projectId);
    const baseState: PlanningGenerationState = existing ?? {
      projectId,
      currentStage: "skeleton",
      completedStages: [],
      stages: [],
      status: "pending",
      resumeAt: new Date().toISOString(),
    };
    const failure = buildPreflightFailureState(baseState, error);
    db.savePlanningState(failure.state);
    // 用户可见可观测性：把 preflight 失败原因打到主进程 console，
    // 避免「继续规划还是报错但日志全无」的报告。err 已通过
    // buildPreflightFailureState 内部 redactSensitiveMessage 处理过；
    // 这里再 raw 输出原 error 一次以方便 grep 调用栈。
    console.warn(`[planning] preflight.failure projectId=${projectId} existingStatus=${existing?.status ?? "none"} message=${(error as { message?: string } | null)?.message ?? "unknown"}`);
    console.warn("[planning] preflight.failure stack", error);
    if (project) {
      db.addMessage(projectId, "assistant", failure.assistantReply, "failed");
      syncProjectStatusAfterFailure(db, projectId);
      emitProject(db.getProject(projectId)!);
    }
    return {
      state: failure.state,
      status: "failed",
      accepted: [],
      rejected: [],
      researchTasks: [],
      assistantReply: failure.assistantReply,
    };
  }

  /** 共享包装：start / resume 都走这条路径，保证 preflight 行为一致。
   *  调用方在调本函数前应已做完各自的前置持久化（start 写 pending、
   *  resume 做受限 restore），这里只负责 preflight + runPlan + 终态同步。 */
  async function runPlanning(projectId: string): Promise<PlanningRunResult> {
    try {
      const project = db.getProject(projectId);
      if (!project) throw projectNotFound(projectId);
      const turnSettings = getSettings();
      // 解密 API Key 必须在 try 内：safeStorage 在某些 macOS 环境下抛
      // "decryption failed"，被外层 catch 接管后写一条 provider_not_configured
      // 的失败消息；这条路径对应 preflight-failure.test.ts 第一组用例。
      const decryptedKey = await apiKey(turnSettings.aiProvider);
      const providerProfile = aiProviderConfig(turnSettings, turnSettings.aiProvider);
      const providerLabel = resolveAiProviderLabel(turnSettings);
      const store = new DbGenerationStateStore(db);
      const runtime = new DbOrchestratorRuntime(db);

      const adapter = new OpenAICompatiblePlannerAdapter({
        apiKey: decryptedKey,
        baseUrl: providerProfile.baseUrl,
        model: providerProfile.model,
      });
      const product = (project.product ?? {}) as Record<string, unknown>;
      const basicInfo = (product.basicInfo ?? {}) as Record<string, unknown>;
      const sales = (product.sales ?? {}) as Record<string, unknown>;
      const result = await runPlan({
        projectId,
        skeleton: {
          destination: String(basicInfo.meetingCity ?? basicInfo.destinationCity ?? ""),
          days: Number(basicInfo.days) || 0,
          nights: Number(basicInfo.nights) || 0,
          productForm: sales.productForm === "groupTour" ? "groupTour" : "privateTour",
          productType: sales.productType === "domesticLong" ? "domesticLong" : "domesticShort",
          supplierProductCode: String(basicInfo.supplierProductCode ?? ""),
        },
        store,
        runtime,
        planner: adapter,
        providerLabel,
      });

      // 终态同步：completed → review、failed/needs_user → blocked，
      // 其它活动状态（automating / draft_saved）一律不动。
      syncProjectStatusAfterRunPlan(db, projectId, result.status);
      // 消息 taskStatus 必须跟 result.status 走：completed → succeeded，
      // failed / needs_user → failed（旧实现不论 result.status 都写
      // succeeded，会让 recovery strip / 项目消息列表把失败轮误标成功）。
      const replyMessageTaskStatus: "succeeded" | "failed" = result.status === "completed" ? "succeeded" : "failed";
      const replyMessageId = db.addMessage(projectId, "assistant", result.assistantReply, replyMessageTaskStatus);
      void replyMessageId;
      emitProject(db.getProject(projectId)!);
      return {
        state: result.state,
        status: result.status,
        accepted: result.accepted.map((entry) => entry.module),
        rejected: result.rejected.map((entry) => ({ module: entry.module, reason: entry.reason })),
        researchTasks: result.researchTasks.map((task) => ({ label: task.label, type: task.type, detail: task.detail })),
        assistantReply: result.assistantReply,
      };
    } catch (error) {
      return handlePreflightFailure(projectId, error);
    }
  }

  /** 把持久化 completed 的 PlanningGenerationState 拼回 PlanningRunResult 形状，
   *  用于 planning:resume 在状态已为 completed 时跳过 runPlanning 直接返回稳定结果。 */
  function buildStableCompletedResult(state: PlanningGenerationState): PlanningRunResult {
    const accepted = state.stages.flatMap((s) => s.accepted.map((m) => m.module));
    const rejected = state.stages.flatMap((s) =>
      s.rejected.map((m) => ({ module: m.module, reason: m.reason })),
    );
    return {
      state,
      status: "completed",
      accepted,
      rejected,
      researchTasks: [],
      assistantReply: state.lastAssistantReply ?? "",
    };
  }

  ipcMain.handle("planning:start", (_event, projectId: string) => {
    // fresh start 语义：先调一次受限 restore —— 仅当 projects.status=blocked 且
    // 旧持久化 planning_generation ∈ {failed, needs_user} 时把 projects.status
    // 改回 planning，再覆盖写 pending state。
    // 必须先 restore 后 save pending：否则 pending state 会先洗掉旧的
    // failed/needs_user 标记，后续 runPlan=completed 走 syncProjectStatusAfterRunPlan
    // 时因 projects.status=blocked 错过 planning→review 推送，UI 永远停在 blocked。
    console.info(`[planning] ipc.start projectId=${projectId}`);
    const existingState = db.loadPlanningState(projectId);
    if (existingState) {
      restoreProjectToPlanningForRetry(db, projectId, existingState.status);
    }
    db.savePlanningState({
      projectId,
      currentStage: "skeleton",
      completedStages: [],
      stages: [],
      status: "pending",
      resumeAt: new Date().toISOString(),
    });
    return runPlanning(projectId);
  });
  ipcMain.handle("planning:resume", (_event, projectId: string) => {
    // resume 必须先 load state：没有持久化记录时没有可恢复上下文，盲目跑
    // 等同 planning:start，应由调用方显式改走 start；这里直接抛错让 IPC
    // 拒绝而不是静默写一条 pending。
    console.info(`[planning] ipc.resume projectId=${projectId}`);
    let existingState: PlanningGenerationState | undefined;
    try {
      existingState = db.loadPlanningState(projectId);
    } catch (error) {
      console.warn(`[planning] ipc.resume load_failed projectId=${projectId}`, error);
      return handlePreflightFailure(projectId, error);
    }
    if (!existingState) {
      console.warn(`[planning] ipc.resume no_state projectId=${projectId}`);
      throw new Error(`planning:resume 拒绝：项目 ${projectId} 没有持久化规划状态，请改用 planning:start`);
    }
    if (existingState.status === "completed") {
      // 已完成的项目不应被 resume 重跑（避免重新调 AI、重复写消息、再次触发
      // syncProjectStatusAfterRunPlan）。直接返回持久化的稳定结果。
      console.info(`[planning] ipc.resume stable_completed projectId=${projectId} currentStage=${existingState.currentStage} completedStages=${existingState.completedStages.join(",")}`);
      return buildStableCompletedResult(existingState);
    }
    // 其他状态：受限 restore —— 仅当 projects.status=blocked 且持久化
    // planning_generation ∈ {failed, needs_user} 时才把 projects.status
    // 恢复为 planning；其他来源的 blocked（自动化孤儿、运营手工、
    // planning_gen=running / pending 等）保持原状。
    try {
      restoreProjectToPlanningForRetry(db, projectId, existingState.status);
    } catch (error) {
      console.warn(`[planning] ipc.resume restore_failed projectId=${projectId}`, error);
      return handlePreflightFailure(projectId, error);
    }
    console.info(`[planning] ipc.resume proceed projectId=${projectId} currentStage=${existingState.currentStage} status=${existingState.status} completedStages=${existingState.completedStages.join(",")}`);
    return runPlanning(projectId);
  });
  ipcMain.handle("planning:state", (_event, projectId: string) => {
    try {
      const state = db.loadPlanningState(projectId);
      console.info(`[planning] ipc.state projectId=${projectId} status=${state?.status ?? "none"} currentStage=${state?.currentStage ?? "none"}`);
      return state;
    } catch (error) {
      console.warn(`[planning] ipc.state failed projectId=${projectId}`, error);
      throw error;
    }
  });
}

/**
 * 在主进程内直接抓当前 VBK 页面的 providerId 并落库：
 *   - 失败仅 console.warn，不抛错（IPC 端也能安静处理）；
 *   - 同时把当前登录账号名从 settings 读出后写回 settings(providerIdByAccount:)。
 */
async function detectProviderIdInMain(): Promise<number | null> {
  try {
    const page = await browser.page();
    const id = await detectProviderIdFromBrowser(page);
    const accountName = db.getSetting("vbkAccountName")?.value;
    if (id && accountName) db.setProviderIdFor(accountName, id);
    return id;
  } catch (error) {
    console.warn("[accounts] detectProviderId failed", error);
    return null;
  }
}
/**
 * 预留：固定信息变化时不需要广播项目更新。
 * 仅保留签名以兼容未来扩展（比如联系人卡片变化后想主动推到 renderer）。
 */
function emitProjectIfKnown(_accountName: string, _info: unknown) { /* 预留：固定信息变化不需要广播项目更新 */ }

app.whenReady().then(async () => {
  db = new VbkDatabase(app.getPath("userData"));
  db.recoverUnansweredMessages();
  const orphanProjects = db.recoverOrphanAutomationRuns();
  if (orphanProjects.length) console.warn("[startup] recovered orphan automation runs", { count: orphanProjects.length });
  const orphanPlanning = db.recoverOrphanPlanningStates();
  if (orphanPlanning.length) console.warn("[startup] recovered orphan planning runs", { count: orphanPlanning.length });
  registerIpc(); await createWindow();
  app.on("activate", () => { if (!BrowserWindow.getAllWindows().length) void createWindow(); });
}).catch((error) => {
  // 启动链路失败时必须可见地退出，否则会留下一个已注册 IPC 但没有窗口的进程。
  console.error(`${APP_NAME} 启动失败：`, error);
  app.quit();
});
app.on("window-all-closed", () => { void browser?.dispose(); if (process.platform !== "darwin") app.quit(); });
app.on("before-quit", () => { void browser?.dispose(); });
