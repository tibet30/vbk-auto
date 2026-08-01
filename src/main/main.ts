import path from "node:path";
import { app, BrowserWindow, ipcMain, safeStorage } from "electron";
import { fileURLToPath } from "node:url";
import { VbkDatabase } from "./database.js";
import { MiniMaxService } from "./minimax.js";
import { applyProductPatch } from "./product-patch.js";
import { productSchema } from "./automation/schema.js";
import { VbkBrowser } from "./vbk-browser.js";
import { DraftAutomation } from "./automation.js";
import type { CreateProjectInput, ProjectDetail, ProjectReadiness, Settings, VbkLoginStatus } from "../shared/contracts.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const isDev = !app.isPackaged;
app.commandLine.appendSwitch("remote-debugging-port", "9222");
const knownVbkAccountName = "vbk_671205";

let window: BrowserWindow; let db: VbkDatabase; let browser: VbkBrowser; let automation: DraftAutomation;
const emitProject = (project: ProjectDetail) => window?.webContents.send("project:updated", project);
const getSettings = (): Settings => ({
  minimaxBaseUrl: db.getSetting("minimaxBaseUrl")?.value || "https://api.minimaxi.com/v1",
  minimaxModel: db.getSetting("minimaxModel")?.value || "MiniMax-M3",
  hasMiniMaxKey: Boolean(db.getSetting("minimaxApiKey")), dataPath: app.getPath("userData"),
});
function apiKey() { const stored = db.getSetting("minimaxApiKey")?.value; return stored ? safeStorage.decryptString(Buffer.from(stored, "base64")) : ""; }
function withKnownVbkAccount(status: VbkLoginStatus): VbkLoginStatus {
  if (!status.loggedIn) return status;
  const accountName = status.accountName || db.getSetting("vbkAccountName")?.value || knownVbkAccountName;
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
  return { ready: issues.length === 0, completion: Math.round((Math.max(0, 12 - Math.min(12, issues.length)) / 12) * 100), issues };
}

async function createWindow() {
  window = new BrowserWindow({ width: 1512, height: 982, minWidth: 1180, minHeight: 760, title: "VBK Desktop", backgroundColor: "#fafafa", webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: path.join(root, "dist-electron", "main", "preload.cjs") } });
  if (isDev) await window.loadURL("http://127.0.0.1:5173"); else await window.loadFile(path.join(root, "dist", "index.html"));
  browser = new VbkBrowser(window); await browser.initialise();
  automation = new DraftAutomation(db, browser, emitProject);
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
  ipcMain.handle("browser:login", () => browser.login());
  ipcMain.handle("browser:logout", () => browser.logout());
  ipcMain.handle("browser:status", async (_event, refresh?: boolean) => withKnownVbkAccount(await browser.status(Boolean(refresh))));
  ipcMain.handle("browser:navigate", (_event, url: string) => browser.navigate(url));
  ipcMain.handle("browser:setBounds", (_event, bounds) => browser.setBounds(bounds));
  ipcMain.handle("browser:setVisible", (_event, visible: boolean) => browser.setVisible(visible));
  ipcMain.handle("automation:start", (_event, projectId: string) => automation.start(projectId));
  ipcMain.handle("automation:retry", (_event, projectId: string) => automation.start(projectId));
  ipcMain.handle("settings:get", () => getSettings());
  ipcMain.handle("settings:getApiKey", () => apiKey());
  ipcMain.handle("settings:save", (_event, input: Partial<Settings> & { apiKey?: string }) => {
    if (input.minimaxBaseUrl !== undefined) {
      const baseUrl = input.minimaxBaseUrl.trim();
      let parsed: URL;
      try { parsed = new URL(baseUrl); } catch { throw new Error("MiniMax 服务地址格式不正确。"); }
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("MiniMax 服务地址必须以 http:// 或 https:// 开头。");
      db.setSetting("minimaxBaseUrl", baseUrl);
    }
    if (input.minimaxModel) db.setSetting("minimaxModel", input.minimaxModel);
    if (input.apiKey) { if (!safeStorage.isEncryptionAvailable()) throw new Error("当前 macOS 无法加密保存密钥"); db.setSetting("minimaxApiKey", safeStorage.encryptString(input.apiKey).toString("base64")); }
    return getSettings();
  });
  ipcMain.handle("settings:test", async (_event, input: Pick<Settings, "minimaxBaseUrl"> & { apiKey?: string }) => {
    const baseUrl = typeof input?.minimaxBaseUrl === "string" ? input.minimaxBaseUrl.trim() : "";
    let parsed: URL;
    try { parsed = new URL(baseUrl); } catch { throw new Error("MiniMax 服务地址格式不正确。"); }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("MiniMax 服务地址必须以 http:// 或 https:// 开头。");
    const key = typeof input.apiKey === "string" && input.apiKey.trim() ? input.apiKey.trim() : apiKey();
    await new MiniMaxService({ apiKey: key, baseUrl, model: getSettings().minimaxModel }).testConnection();
    return { connected: true, message: "连接测试通过。" };
  });
}

app.whenReady().then(async () => { db = new VbkDatabase(app.getPath("userData")); db.recoverUnansweredMessages(); registerIpc(); await createWindow(); app.on("activate", () => { if (!BrowserWindow.getAllWindows().length) void createWindow(); }); });
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
