/**
 * Electron main process entry: process configuration, shared runtime helpers,
 * IPC registrar composition, and application bootstrap.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow } from "electron";
import { installLogSink, logError, logWarn } from "../shared/log-timestamp.js";
import { createRuntimeLogCapture } from "../shared/log-redaction.js";
import { APP_NAME } from "../shared/brand.js";
import { aiProviderConfig, aiProviderLabel as resolveAiProviderLabel } from "../shared/ai-provider-config.js";
import type {
  AiProvider,
  Planner,
  PlanningGenerationState,
  ProductDetail,
  ProductReadiness,
  Settings,
} from "../shared/contracts.js";
import { isAiProvider } from "../shared/contracts.js";
import { DraftAutomation } from "./automation/automation.js";
import { VbkDatabase } from "./infrastructure/database/database.js";
import { productNotFound } from "./infrastructure/db-errors.js";
import { computeReadiness } from "./readiness.js";
import { detectProviderIdFromBrowser } from "./infrastructure/provider-id-source.js";
import { VbkBrowser } from "./infrastructure/vbk-browser.js";
import {
  createLocalAiKeyStore,
  LOCAL_AI_KEY_FILE_NAME,
  type LocalAiKeyStore,
} from "./infrastructure/ai-key-store.js";
import {
  createLocalVbkCookieStore,
  LOCAL_VBK_COOKIE_FILE_NAME,
  type LocalVbkCookieStore,
} from "./infrastructure/vbk-cookie-store.js";
import { createAppAuthStore, LOCAL_APP_AUTH_FILE_NAME } from "./infrastructure/app-auth-store.js";
import { createTibetAuthService, type TibetAuthService } from "./infrastructure/tibet-auth.js";
import { createTibetProductService } from "./infrastructure/tibet-products.js";
import { MiniMaxService } from "./minimax/minimax.js";
import { OpenAICompatiblePlannerAdapter, planningTransportOptions } from "./planning/adapters/openai-compatible-adapter.js";
import { createMainWindow } from "./create-window.js";
import { registerProductAiIpc } from "./ipc/product-ai-ipc.js";
import { registerRemoteProductIpc } from "./ipc/remote-product-ipc.js";
import { registerBrowserAutomationIpc } from "./ipc/browser-automation-ipc.js";
import { registerSettingsIpc } from "./ipc/settings-ipc.js";
import { registerPlanningV2Ipc } from "./ipc/planning-v2-ipc.js";
import { registerAppAuthIpc } from "./ipc/app-auth-ipc.js";
import type { MainIpcContext } from "./ipc/context.js";
import { ProductWorkflowCoordinator } from "./application/product-workflow-coordinator.js";
import { ProductMutationService } from "./application/product-mutation-service.js";
import { createRemoteProductMirror } from "./application/remote-product-mirror.js";
import { applyAppMetadata, applyDevDockIcon, installApplicationMenu } from "./app-branding.js";
import { cleanStaleChromiumProfileDb } from "./infrastructure/chromium-profile-cleanup.js";
import { createWithKnownVbkAccount } from "./infrastructure/vbk-account-status.js";
import { createVbkBindingBootstrap } from "./infrastructure/vbk-binding-bootstrap.js";
import { captureRuntimeLog, setOperationLogDb } from "./operations/operation-log-store.js";
import {
  applyStartupCommandLineSwitches,
  debuggingPort,
  defaultMiniMaxModel,
  installProcessErrorHandlers,
  isDev,
  logPoiManualIpc,
} from "./startup-config.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
applyAppMetadata();
applyStartupCommandLineSwitches();
installProcessErrorHandlers();

let window: BrowserWindow;
let db: VbkDatabase;
let browser: VbkBrowser;
let automation: DraftAutomation;

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!window || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  });
}
/**
 * Local AI API key store. One instance per process; backed by a single
 * 0600 JSON file under `app.getPath('userData')` (see ai-key-store.ts).
 * Must be created *after* `app.whenReady()` so `userData` is available;
 * main.ts initialises this in `bootstrap()` together with the database.
 */
let aiKeyStore: LocalAiKeyStore | null = null;
/**
 * Local VBK cookie-session store. Same 0600 JSON file pattern as the AI
 * key store. Created in `bootstrap()` together with the database and
 * aiKeyStore, then wired into VbkBrowser as the `LoginSessionStore`.
 *
 * 「null until bootstrap」语义与 aiKeyStore 一致：所有 cookieStore 消费
 * 方都假设它在 createWindow 之前已就绪；createWindow 内部直接使用非空
 * 引用，bootstrap 失败会通过 app.whenReady 的 .catch 退出进程。
 */
let cookieStore: LocalVbkCookieStore | null = null;
// 关闭窗口后 AI 或自动化可能仍在运行，向已销毁的 webContents 发送会抛异常。
/**
 * 向 renderer 广播「产品更新」事件：
 *   - 关闭窗口后 webContents 可能销毁，因此先 isDestroyed 判定；
 *   - 这条事件供 UI 实时刷新产品详情 / 操作日志。
 */
const broadcastProduct = (product: ProductDetail) => {
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return;
  window.webContents.send("product:updated", product);
};
let productEmitter: (product: ProductDetail) => void = broadcastProduct;
const emitProduct = (product: ProductDetail) => productEmitter(product);
/**
 * 规划状态在成功落库后才广播。该事件是 renderer 的实时来源；首次打开产品
 * 仍通过 planning:state 补偿，避免订阅建立前的事件丢失。
 */
const emitPlanningState = (state: PlanningGenerationState) => {
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return;
  // isDestroyed() 与 send() 之间窗口仍可能刚好被销毁。状态已经落库，通知失败
  // 只能丢给下一次 planning:state 补偿，绝不能让主进程规划任务因 UI 生命周期失败。
  try {
    window.webContents.send("planning:updated", state.localProductId, state);
  } catch {
    // renderer 重建 / 退出期间没有可投递目标；持久化状态仍是权威来源。
  }
};
/**
 * 删除 settings 表里某个 provider 的旧密文。
 * 安全的意义上：只删一行 key，失败会 warn 但不抛错；不应让表清理错误
 * 阻塞主流程的设置保存。这是用户决策「脱离 Electron Keychain-backed
 * 加密」后的迁移路径 —— 旧的 `minimaxApiKey` / `deepseekApiKey` 字段
 * 保存的是历史密文（base64），本地 store 接手后不再读取这些字段，留
 * 在表里只会造成隐患。
 *
 * 任何失败都只 warn，不会抛出。此函数不阻塞主流程：设置保存本身的
 * 成功链路已走 aiKeyStore.setKey，即使这里出现异常也不应该带异常外。
 */
function safeRemoveLegacyCiphertext(db: VbkDatabase, key: string): void {
  try {
    if (!db.getSetting(key)) return;
    db.deleteSetting(key);
  } catch (error) {
    logWarn("[settings] failed to remove legacy cipher row", { key, message: (error as { message?: string })?.message ?? "unknown" });
  }
}

/**
 * 把 settings 表中的字段聚合成对外的 Settings 对象（含 hasKey 这类派生布尔）。
 * 当 db 里没值时回落到默认值；用于 UI 渲染 / IPC 拿 setting 时不必关心落库字段。
 *
 * hasKey 一律从本地 aiKeyStore 读取（0600 JSON 文件），不再读取 SQLite 里的
 * legacy ciphertext —— 老字段一律视为未配置，避免把无效密文算成"已配置"。
 * 必须等待 aiKeyStore 初始化完成，否则本地 store 还没就绪时 UI 会错报未配置。
 */
const getSettings = (): Settings => ({
  aiProvider: isAiProvider(db.getSetting("aiProvider")?.value) ? db.getSetting("aiProvider")!.value as AiProvider : "minimax",
  minimaxBaseUrl: db.getSetting("minimaxBaseUrl")?.value || "https://api.minimaxi.com/v1",
  minimaxModel: db.getSetting("minimaxModel")?.value || defaultMiniMaxModel,
  deepseekBaseUrl: db.getSetting("deepseekBaseUrl")?.value || "https://api.evolink.ai/v1",
  deepseekModel: db.getSetting("deepseekModel")?.value || "deepseek-v4-flash",
  hasMiniMaxKey: aiKeyStore ? aiKeyStore.hasKey("minimax") : false,
  hasDeepSeekKey: aiKeyStore ? aiKeyStore.hasKey("deepseek") : false,
  dataPath: app.getPath("userData"),
});
/**
 * 异步加载指定 provider 的真实 API Key：
 *   - 走本地 aiKeyStore（0600 JSON 文件），不再依赖 Keychain 加密层；
 *   - probe 失败时（store 尚未初始化、文件被外部破坏）返回空串，让上层按
 *     "未配置" 安全降级，而不是把错误冒泡到 UI。
 */
async function apiKey(provider: AiProvider = getSettings().aiProvider) {
  if (!aiKeyStore) return "";
  return aiKeyStore.getKey(provider);
}

/** 已完成方案只允许 POI 查询/名称纠正；Key 不可用时安全降级到人工核查。 */
async function completedPoiBackfillPlanner(localProductId: string): Promise<{ planner: Planner; providerLabel?: string }> {
  const planner: Planner = {
    generateStage: async () => { throw new Error("已完成 POI 回填不应调用 AI planner"); },
  };
  const settings = getSettings();
  const hasActiveKey = settings.aiProvider === "deepseek" ? settings.hasDeepSeekKey : settings.hasMiniMaxKey;
  if (!hasActiveKey) return { planner };
  try {
    const decryptedKey = await apiKey(settings.aiProvider);
    const providerProfile = aiProviderConfig(settings, settings.aiProvider);
    const resolverAdapter = new OpenAICompatiblePlannerAdapter({
      apiKey: decryptedKey,
      baseUrl: providerProfile.baseUrl,
      model: providerProfile.model,
      ...planningTransportOptions(settings.aiProvider),
    });
    return {
      planner: { ...planner, resolvePoiName: resolverAdapter.resolvePoiName.bind(resolverAdapter) },
      providerLabel: resolveAiProviderLabel(settings),
    };
  } catch (error) {
    logWarn(`[planning] poi_backfill.resolver_unavailable localProductId=${localProductId}`, error);
    return { planner };
  }
}
/**
 * 按当前 settings 构造 MiniMaxService：
 *   - provider=deepseek 时切到 Evolink baseUrl/model；
 *   - apiKey 通过本地 aiKeyStore（0600 JSON 文件）异步读取；
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
 * 计算产品 readiness：把产品当前状态、已保存自动化运行、是否阻塞等映射到对外的 ProductReadiness。
 * 用于 UI 顶栏显示与 IPC 路由。
 *
 * 实际计算逻辑（needs_user 阻塞的「可见性」红线、completion 算法）已抽到
 * ./readiness.ts 的纯函数 computeReadiness，便于单测覆盖 contact 不在 VBK
 * 下拉 / 用户主动取消等场景；本函数只负责 db.getProduct + productNotFound
 * 的包装与抛错。
 */
function readiness(localProductId: string): ProductReadiness {
  const product = db.getProduct(localProductId); if (!product) throw productNotFound(localProductId);
  return computeReadiness({
    product: product.product,
    researchTasks: product.researchTasks,
    automation: product.automation,
  });
}


async function detectProviderIdInMain(): Promise<number | null> {
  try {
    const page = await browser.page();
    const id = await detectProviderIdFromBrowser(page);
    const accountName = db.getSetting("vbkAccountName")?.value;
    if (id && accountName) db.setProviderIdFor(accountName, id);
    return id;
  } catch (error) {
    logWarn("[accounts] detectProviderId failed", error);
    return null;
  }
}

function emitProductIfKnown(_accountName: string, _info: unknown): void {
  // Reserved for future account-fixed-info renderer notifications.
}

function registerIpc(
  context: MainIpcContext,
  appAuth: TibetAuthService,
  onAuthenticated?: Parameters<typeof registerAppAuthIpc>[1],
): void {
  registerAppAuthIpc(appAuth, onAuthenticated);
  registerRemoteProductIpc(context);
  registerProductAiIpc(context);
  registerBrowserAutomationIpc(context);
  registerSettingsIpc(context);
  registerPlanningV2Ipc(context);
}

async function openMainWindow(): Promise<void> {
  if (!cookieStore) throw new Error("VBK cookie store 尚未初始化，请稍后重试。");
  const services = await createMainWindow({
    db,
    cookieStore,
    root,
    isDev,
    debuggingPort,
    getSettings,
    aiService,
    emitProduct,
    onWindowCreated: (createdWindow) => { window = createdWindow; },
    onServicesCreated: (services) => {
      window = services.window;
      browser = services.browser;
      automation = services.automation;
    },
  });
  window = services.window;
  browser = services.browser;
  automation = services.automation;
}

app.whenReady().then(async () => {
  applyDevDockIcon(root);
  installApplicationMenu();
  // 启动期清理 Chromium 上一版本遗留的 ServiceWorker / QuotaManager 脏库：
  // 必须在构造 VbkDatabase / 创建 BrowserWindow 之前完成，否则 storage service
  // 已经开始读这些库就会撞到 schema 不兼容报错。
  cleanStaleChromiumProfileDb(app.getPath("userData"));
  db = new VbkDatabase(app.getPath("userData"));
  setOperationLogDb(db);
  installLogSink((level, args) => captureRuntimeLog(createRuntimeLogCapture(level, "main", args)));
  aiKeyStore = createLocalAiKeyStore(path.join(app.getPath("userData"), LOCAL_AI_KEY_FILE_NAME));
  cookieStore = createLocalVbkCookieStore(path.join(app.getPath("userData"), LOCAL_VBK_COOKIE_FILE_NAME));
  const appAuthStore = createAppAuthStore(path.join(app.getPath("userData"), LOCAL_APP_AUTH_FILE_NAME));
  const appAuth = createTibetAuthService(appAuthStore);
  const remoteProducts = createTibetProductService(appAuthStore);
  const vbkBindings = createVbkBindingBootstrap({
    appAuthStore,
    db,
    getCookieStore: () => cookieStore,
    getBrowser: () => browser,
  });
  db.setExtensionUserIdResolver(vbkBindings.getExtensionUserId);
  const withKnownVbkAccount = createWithKnownVbkAccount({
    db,
    getBrowser: () => browser,
    noteVbkAccountActive: vbkBindings.noteVbkAccountActive,
  });
  const productWorkflows = new ProductWorkflowCoordinator();
  productEmitter = createRemoteProductMirror({
    remote: remoteProducts,
    broadcast: broadcastProduct,
    isWorkflowActive: (productId) => Boolean(productWorkflows.activeWorkflow(productId)),
  }).emit;
  db.recoverUnansweredMessages();
  const orphanProducts = db.recoverOrphanAutomationRuns();
  if (orphanProducts.length) logWarn("[startup] recovered orphan automation runs", { count: orphanProducts.length });
  const orphanPlanning = db.recoverOrphanPlanningStates();
  if (orphanPlanning.length) logWarn("[startup] recovered orphan planning runs", { count: orphanPlanning.length });
  const orphanLogs = db.recoverOrphanOperationLog();
  if (orphanLogs) logWarn("[startup] recovered interrupted log entries", { count: orphanLogs });

  const context: MainIpcContext = {
    db,
    get browser() { return browser; },
    get automation() { return automation; },
    aiKeyStore,
    getSettings,
    apiKey,
    aiService,
    productWorkflows,
    productMutations: new ProductMutationService(db, emitProduct),
    remoteProducts,
    bindingSync: vbkBindings.bindingSync,
    getExtensionUserId: vbkBindings.getExtensionUserId,
    noteVbkAccountActive: vbkBindings.noteVbkAccountActive,
    readiness,
    emitProduct,
    broadcastProduct,
    emitPlanningState,
    withKnownVbkAccount,
    completedPoiBackfillPlanner,
    safeRemoveLegacyCiphertext,
    detectProviderIdInMain,
    emitProductIfKnown,
    logPoiManualIpc,
  };
  registerIpc(context, appAuth, { onAuthenticated: vbkBindings.onAuthenticated });
  await openMainWindow();
  // 本地 renderer 已可交互；VBK 恢复与远端绑定同步在后台串接，失败不退出应用。
  void browser.initialise()
    .then(() => vbkBindings.afterBrowserReady())
    .catch((error) => logWarn("[startup] deferred VBK binding restore failed", error));
  app.on("activate", () => {
    if (!BrowserWindow.getAllWindows().length) void openMainWindow();
  });
}).catch((error) => {
  logError(`${APP_NAME} 启动失败：`, error);
  app.quit();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
let isDisposing = false;
app.on("before-quit", (event) => {
  if (isDisposing || !browser) return;
  isDisposing = true;
  event.preventDefault();
  void browser.dispose().finally(() => app.exit(0));
});
