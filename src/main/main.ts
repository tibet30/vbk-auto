import path from "node:path";
import { app, BrowserWindow, ipcMain, safeStorage } from "electron";
import { fileURLToPath } from "node:url";
import { VbkDatabase } from "./database.js";
import { MiniMaxService } from "./minimax.js";
import { applyProductPatch } from "./product-patch.js";
import { automationBlockers, productSchema } from "./automation/schema.js";
import { VbkBrowser } from "./vbk-browser.js";
import { DraftAutomation } from "./automation.js";
import { resolveVehicleResource } from "./vehicle-resource.js";
import type { CreateProjectInput, ProjectDetail, ProjectReadiness, Settings, VbkLoginStatus } from "../shared/contracts.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const isDev = !app.isPackaged;
// 自动化通过 CDP 驱动内嵌的 VBK 页面，端口必须开着；但固定的 9222 可被
// 本机任意进程预测并接管这个已登录会话，也会和其它 Chrome 实例抢占。
// 改为每次启动随机取一个端口，并只监听回环地址。
const debuggingPort = String(9300 + Math.floor(Math.random() * 600));
app.commandLine.appendSwitch("remote-debugging-port", debuggingPort);
app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");
const defaultMiniMaxModel = process.env.MINIMAX_MODEL?.trim() || "MiniMax-M2.7-highspeed";

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
  if (accountName) db.setSetting("vbkAccountName", accountName);
  const accounts = Array.from(new Set([...(status.accounts || []), accountName].filter(Boolean)));
  return { ...status, accountName, accounts };
}
function readiness(projectId: string): ProjectReadiness {
  const project = db.getProject(projectId); if (!project) throw new Error("项目不存在");
  const issues: ProjectReadiness["issues"] = [];
  const parsed = productSchema.safeParse(project.product);
  if (!parsed.success) {
    for (const issue of parsed.error.issues.slice(0, 6)) issues.push({ label: issue.path.join(".") || "产品方案", detail: issue.message });
  }
  const unresolved = project.researchTasks.filter((task) => task.state !== "confirmed" && task.state !== "resolved");
  for (const task of unresolved) issues.push({ label: task.label, detail: task.detail || "需要在 VBK 或公开来源完成核查" });
  // 与自动录入使用同一套要求，避免界面显示「可以录入」后才在携程失败。
  if (parsed.success) for (const blocker of automationBlockers(project.product)) issues.push(blocker);
  return { ready: issues.length === 0, completion: Math.round((Math.max(0, 12 - Math.min(12, issues.length)) / 12) * 100), issues };
}

async function createWindow() {
  window = new BrowserWindow({ width: 1512, height: 982, minWidth: 1180, minHeight: 760, title: "VBK Desktop", backgroundColor: "#fafafa", webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: path.join(root, "dist-electron", "main", "preload.cjs") } });
  if (isDev) await window.loadURL("http://127.0.0.1:5173"); else await window.loadFile(path.join(root, "dist", "index.html"));
  browser = new VbkBrowser(window, debuggingPort); await browser.initialise();
  automation = new DraftAutomation(db, browser, emitProject);
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
  ipcMain.handle("projects:create", (_event, input: CreateProjectInput) => { const project = db.createProject(input); emitProject(project); return project; });
  ipcMain.handle("projects:get", (_event, id: string) => db.getProject(id));
  ipcMain.handle("projects:readiness", (_event, id: string) => readiness(id));
  ipcMain.handle("ai:send", async (_event, projectId: string, content: string) => {
    const project = db.getProject(projectId); if (!project) throw new Error("项目不存在");
    const message = typeof content === "string" ? content.trim() : "";
    if (!message) throw new Error("请输入要发送给 AI 的内容。");
    if (message.length > 6000) throw new Error("单条消息不能超过 6000 个字符，请拆分后发送。");
    const userMessageId = db.addMessage(projectId, "user", message, "running");
    emitProject(db.getProject(projectId)!);
    try {
      const history = project.messages.filter((item) => (item.role === "user" || item.role === "assistant") && item.taskStatus !== "failed" && item.taskStatus !== "running");
      const settings = getSettings(); const response = await new MiniMaxService({ apiKey: apiKey(), baseUrl: settings.minimaxBaseUrl, model: settings.minimaxModel }).reply({ message, product: project.product, history: history.map((item) => ({ role: item.role, content: item.content })) });
      const next = response.patch?.length ? applyProductPatch(project.product, response.patch) : project.product;
      db.updateProduct(projectId, next); db.updateMessageStatus(projectId, userMessageId, "succeeded"); db.addMessage(projectId, "assistant", response.reply, "succeeded");
      for (const task of response.researchTasks || []) db.addResearchTask(projectId, task);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "AI 服务暂时无法完成本次请求。";
      db.updateMessageStatus(projectId, userMessageId, "failed");
      db.addMessage(projectId, "assistant", `本轮没有获得 AI 回复：${reason} 请检查连接或配置后重试。`, "failed");
    }
    emitProject(db.getProject(projectId)!);
  });
  ipcMain.handle("research:accept", (_event, projectId: string, taskId: string, note?: string) => { db.markResearchAccepted(projectId, taskId, note); emitProject(db.getProject(projectId)!); });
  ipcMain.handle("research:vehicleResource", async (_event, projectId: string, taskId?: string) => {
    const project = db.getProject(projectId); if (!project) throw new Error("项目不存在");
    const page = await browser.page();
    const result = await resolveVehicleResource(page, project);
    db.updateProduct(projectId, result.product, "review");
    if (taskId) db.markResearchAccepted(projectId, taskId, result.note, "vbk");
    db.addMessage(projectId, "assistant", `已完成用车估算和 VBK 资源组匹配：${result.note}`, "succeeded");
    const next = db.getProject(projectId)!;
    emitProject(next);
    return result.resolved;
  });
  ipcMain.handle("browser:login", () => browser.login());
  ipcMain.handle("browser:logout", () => browser.logout());
  ipcMain.handle("browser:status", async (_event, refresh?: boolean) => withKnownVbkAccount(await browser.status(Boolean(refresh))));
  ipcMain.handle("browser:navigate", (_event, url: string) => browser.navigate(url));
  ipcMain.handle("browser:openExternal", () => browser.openExternal());
  ipcMain.handle("browser:setBounds", (_event, bounds) => browser.setBounds(bounds));
  ipcMain.handle("browser:setVisible", (_event, visible: boolean) => browser.setVisible(visible));
  ipcMain.handle("automation:start", (_event, projectId: string) => automation.start(projectId));
  ipcMain.handle("automation:retry", (_event, projectId: string) => automation.start(projectId));
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
}

app.whenReady().then(async () => { db = new VbkDatabase(app.getPath("userData")); db.recoverUnansweredMessages(); registerIpc(); await createWindow(); app.on("activate", () => { if (!BrowserWindow.getAllWindows().length) void createWindow(); }); }).catch((error) => {
  // 启动链路失败时必须可见地退出，否则会留下一个已注册 IPC 但没有窗口的进程。
  console.error("VBK Desktop 启动失败：", error);
  app.quit();
});
app.on("window-all-closed", () => { void browser?.dispose(); if (process.platform !== "darwin") app.quit(); });
app.on("before-quit", () => { void browser?.dispose(); });
