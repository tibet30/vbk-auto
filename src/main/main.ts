import path from "node:path";
import { app, BrowserWindow, ipcMain, safeStorage } from "electron";
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
import type { AccountFixedInfoFieldKey, AccountFixedInfoValue, CreateProjectInput, ManualReviewFieldInput, OperationLogQuery, ProjectDetail, ProjectReadiness, Settings, VbkLoginStatus } from "../shared/contracts.js";
import { VbkDatabaseError, projectNotFound } from "./infrastructure/db-errors.js";
import {
  classifyMiniMaxError,
  extractMiniMaxFailureReason,
  normalizeFailureMessage,
  stripRetryHintTail,
  toRetryHint,
} from "./minimax/minimax-error-handling.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const isDev = !app.isPackaged;
// 自动化通过 CDP 驱动内嵌的 VBK 页面，端口必须开着；但固定的 9222 可被
// 本机任意进程预测并接管这个已登录会话，也会和其它 Chrome 实例抢占。
// 改为每次启动随机取一个端口，并只监听回环地址。
const debuggingPort = String(9300 + Math.floor(Math.random() * 600));
app.commandLine.appendSwitch("remote-debugging-port", debuggingPort);
app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");
const defaultMiniMaxModel = process.env.MINIMAX_MODEL?.trim() || "MiniMax-M3";

let window: BrowserWindow; let db: VbkDatabase; let browser: VbkBrowser; let automation: DraftAutomation;
// 关闭窗口后 AI 或自动化可能仍在运行，向已销毁的 webContents 发送会抛异常。
const emitProject = (project: ProjectDetail) => {
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return;
  window.webContents.send("project:updated", project);
};
const getSettings = (): Settings => ({
  minimaxBaseUrl: db.getSetting("minimaxBaseUrl")?.value || "https://api.minimaxi.com/v1",
  minimaxModel: db.getSetting("minimaxModel")?.value || defaultMiniMaxModel,
  hasMiniMaxKey: Boolean(db.getSetting("minimaxApiKey")), dataPath: app.getPath("userData"),
});
function apiKey() { const stored = db.getSetting("minimaxApiKey")?.value; return stored ? safeStorage.decryptString(Buffer.from(stored, "base64")) : ""; }
function withKnownVbkAccount(status: VbkLoginStatus): VbkLoginStatus {
  if (!status.loggedIn) return status;
  // 页面抓取不到账号名时只沿用本机上次记录，不再回退到某个固定账号：
  // 那会把当前登录者错标成别人，并写进本地设置长期生效。
  const accountName = status.accountName || db.getSetting("vbkAccountName")?.value || "";
  if (accountName) {
    db.setSetting("vbkAccountName", accountName);
    scheduleProviderIdRefresh(accountName, detectProviderIdFromBrowser, (id: number | null) => db.setProviderIdFor(accountName, id));
  }
  const accounts = Array.from(new Set([...(status.accounts || []), accountName].filter(Boolean)));
  return { ...status, accountName, accounts };
}
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

async function createWindow() {
  window = new BrowserWindow({ width: 1512, height: 982, minWidth: 1180, minHeight: 760, title: "VBK Desktop", backgroundColor: "#fafafa", webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: path.join(root, "dist-electron", "main", "preload.cjs") } });
  if (isDev) await window.loadURL("http://127.0.0.1:5173"); else await window.loadFile(path.join(root, "dist", "index.html"));
  browser = new VbkBrowser(window, debuggingPort); await browser.initialise();
  automation = new DraftAutomation(db, browser, emitProject, async (req) => {
    const settings = getSettings();
    const service = new MiniMaxService({ apiKey: apiKey(), baseUrl: settings.minimaxBaseUrl, model: settings.minimaxModel });
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
    const service = new MiniMaxService({ apiKey: apiKey(), baseUrl: settings.minimaxBaseUrl, model: settings.minimaxModel });
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

function assertSafeMiniMaxUrl(value: string) {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error("MiniMax 服务地址格式不正确。"); }
  // API Key 通过 Authorization 头随每次请求发出，明文 http 会让密钥在网络上
  // 可被截获、响应可被篡改（进而改写产品草稿），因此只放行 https 与本机地址。
  const isLoopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "[::1]";
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopback)) {
    throw new Error("MiniMax 服务地址必须使用 https://（本机调试可用 http://127.0.0.1）。");
  }
  return parsed;
}

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
  async function runAiReply(projectId: string, content: string) {
    const project = db.getProject(projectId); if (!project) throw projectNotFound(projectId);
    const message = typeof content === "string" ? content.trim() : "";
    if (!message) throw new Error("请输入要发送给 AI 的内容。");
    if (message.length > 6000) throw new Error("单条消息不能超过 6000 个字符，请拆分后发送。");
    const userMessageId = db.addMessage(projectId, "user", message, "running");
    emitProject(db.getProject(projectId)!);
    try {
      const history = project.messages.filter((item) => (item.role === "user" || item.role === "assistant") && item.taskStatus !== "failed" && item.taskStatus !== "running");
      const settings = getSettings();
      const service = new MiniMaxService({ apiKey: apiKey(), baseUrl: settings.minimaxBaseUrl, model: settings.minimaxModel });
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
              console.warn("[MiniMax] planning request failed, run connectivity check before retry", {
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
        throw new MiniMaxServiceError("invalid_model_output", "MiniMax 未返回可写入的产品方案，请重试。");
      }
      const responsePatch = response.patch ?? [];
      const patchResult = responsePatch.length ? applyProductPatchSafe(project.product, responsePatch) : { product: project.product, applied: false };
      const next = patchResult.product;
      if (requiresWritablePatch && (responsePatch.length === 0 || !patchResult.applied)) {
        throw new MiniMaxServiceError("invalid_model_output", "MiniMax 未返回可写入的产品方案，请重试。");
      }
      db.updateProduct(projectId, next); db.updateMessageStatus(projectId, userMessageId, "succeeded"); db.addMessage(projectId, "assistant", response.reply, "succeeded");
      for (const task of response.researchTasks || []) db.addResearchTask(projectId, task);
    } catch (error) {
      const reason = extractMiniMaxFailureReason(error) || (error instanceof Error ? error.message : "AI 服务暂时无法完成本次请求。");
      const errorCode = classifyMiniMaxError(error);
      const finalMessage = normalizeFailureMessage(errorCode, reason);
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
  ipcMain.handle("settings:getApiKey", () => apiKey());
  ipcMain.handle("settings:save", (_event, input: Partial<Settings> & { apiKey?: string }) => {
    if (input.minimaxBaseUrl !== undefined) {
      const baseUrl = input.minimaxBaseUrl.trim();
      assertSafeMiniMaxUrl(baseUrl);
      db.setSetting("minimaxBaseUrl", baseUrl);
    }
    if (input.minimaxModel) db.setSetting("minimaxModel", input.minimaxModel);
    if (input.apiKey) { if (!safeStorage.isEncryptionAvailable()) throw new Error("当前 macOS 无法加密保存密钥"); db.setSetting("minimaxApiKey", safeStorage.encryptString(input.apiKey).toString("base64")); }
    return getSettings();
  });
  ipcMain.handle("settings:test", async (_event, input: Pick<Settings, "minimaxBaseUrl"> & { apiKey?: string }) => {
    const baseUrl = typeof input?.minimaxBaseUrl === "string" ? input.minimaxBaseUrl.trim() : "";
    assertSafeMiniMaxUrl(baseUrl);
    const key = typeof input.apiKey === "string" && input.apiKey.trim() ? input.apiKey.trim() : apiKey();
    await new MiniMaxService({ apiKey: key, baseUrl, model: getSettings().minimaxModel }).testConnection();
    return { connected: true, message: "连接测试通过。" };
  });
  // 读取自动化操作历史。早期版本返回内存样例，等真实写入路径就绪后再
  // 改读持久化文件；查询语义保持一致以免上层调用方重写。
  ipcMain.handle("operationLog:load", (_event, query?: OperationLogQuery) => loadOperationLog(query));
}

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
function emitProjectIfKnown(_accountName: string, _info: unknown) { /* 预留：固定信息变化不需要广播项目更新 */ }

app.whenReady().then(async () => {
  db = new VbkDatabase(app.getPath("userData"));
  db.recoverUnansweredMessages();
  const orphanProjects = db.recoverOrphanAutomationRuns();
  if (orphanProjects.length) console.warn("[startup] recovered orphan automation runs", { count: orphanProjects.length });
  registerIpc(); await createWindow();
  app.on("activate", () => { if (!BrowserWindow.getAllWindows().length) void createWindow(); });
}).catch((error) => {
  // 启动链路失败时必须可见地退出，否则会留下一个已注册 IPC 但没有窗口的进程。
  console.error("VBK Desktop 启动失败：", error);
  app.quit();
});
app.on("window-all-closed", () => { void browser?.dispose(); if (process.platform !== "darwin") app.quit(); });
app.on("before-quit", () => { void browser?.dispose(); });
