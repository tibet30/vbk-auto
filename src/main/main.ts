import { installProductAgent } from "./agent/integration-setup.js";
/** Electron main process entry and application bootstrap. */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow } from "electron";
import { logError, logWarn } from "../shared/log-timestamp.js";
import { APP_NAME } from "../shared/brand.js";
import type {
  PlanningGenerationState,
  ProductDetail,
} from "../shared/contracts.js";
import { DraftAutomation } from "./automation/automation.js";
import { VbkDatabase } from "./infrastructure/database/database.js";
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
import { createTibetAuthService } from "./infrastructure/tibet-auth.js";
import { createTibetCopyRuleSync } from "./infrastructure/tibet-copy-rules.js";
import { createProductStorage } from "./application/product-storage.js";
import { createMainWindow } from "./create-window.js";
import { ProductTaskScheduler } from "./application/product-task-scheduler.js";
import type { ProductWorkflowTask } from "../shared/contracts.js";
import type { MainIpcContext } from "./ipc/context.js";
import { ProductWorkflowCoordinator } from "./application/product-workflow-coordinator.js";
import { ProductMutationService } from "./application/product-mutation-service.js";
import { AppUpdateService } from "./application/app-update-service.js";
import { createWithKnownVbkAccount } from "./infrastructure/vbk-account-status.js";
import { createVbkBindingBootstrap } from "./infrastructure/vbk-binding-bootstrap.js";
import { captureRuntimeLog, setOperationLogDb } from "./operations/operation-log-store.js";
import { createRuntimeLogCapture } from "../shared/log-redaction.js";
import { MemoryService } from "./memory/memory-service.js";
import {
  createMainAiRuntime,
  createProviderIdDetector,
  evaluateMainReadiness,
  safeRemoveLegacyCiphertext,
  scheduleMemoryMaintenance,
} from "./main-runtime.js";
import { registerMainIpc } from "./main-ipc.js";
import { recoverQueuedAgentWorkflowTasks } from "./agent/integration-workflow.js";
import {
  applyAppMetadata,
  applyDevDockIcon,
  installApplicationMenu,
} from "./app-branding.js";
import { cleanStaleChromiumProfileDb } from "./infrastructure/chromium-profile-cleanup.js";
import {
  applyStartupCommandLineSwitches,
  debuggingPort,
  defaultMiniMaxModel,
  installProcessErrorHandlers,
  isDev,
  logPoiManualIpc,
} from "./startup-config.js";
import { installLogSink } from "../shared/log-timestamp.js";
import { createMainEventBroadcasters } from "./main-events.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
applyAppMetadata();
applyStartupCommandLineSwitches();
installProcessErrorHandlers();

const userDataDirOverride = process.env.VBK_USER_DATA_DIR?.trim();
if (userDataDirOverride) {
  app.setPath("userData", userDataDirOverride);
}

let window!: BrowserWindow;
let db!: VbkDatabase;
let browser!: VbkBrowser;
let automation!: DraftAutomation;
let updateService!: AppUpdateService;
let isQuittingForUpdate = false;
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
let productWorkflows: ProductWorkflowCoordinator | null = null;
let productStorage: ReturnType<typeof createProductStorage> | null = null;

const {
  getSettings,
  apiKey,
  aiService,
  completedPoiBackfillPlanner,
} = createMainAiRuntime({
  getDb: () => db!,
  getAiKeyStore: () => aiKeyStore!,
  dataPath: () => app.getPath("userData"),
  defaultMiniMaxModel,
});

// main-events.ts 工厂：把 emit 函数集中管理，避免本文件继续膨胀。
// 通过 getter 让 events 看到最新模块级状态（db / window / productStorage）。
const events = createMainEventBroadcasters({
  getWindow: () => window,
  getDb: () => db,
  getSettings,
  getProductStorage: () => productStorage,
  getProductWorkflows: () => productWorkflows,
});
const {
  broadcastProduct,
  emitProduct,
  emitPlanningState,
  emitWorkflowTask,
  emitAgentSnapshot,
  emitProductIfKnown,
  installProductEmitter,
} = events;

const readiness = (
  localProductId: string,
  options: Parameters<typeof evaluateMainReadiness>[2] = {},
) => evaluateMainReadiness(db!, localProductId, options);

const detectProviderIdInMain = createProviderIdDetector({
  getBrowser: () => browser ?? undefined,
  getDb: () => db ?? undefined,
});

async function openMainWindow(): Promise<void> {
  if (!cookieStore) throw new Error("VBK cookie store 尚未初始化，请稍后重试。");
  const services = await createMainWindow({
    db: db!,
    cookieStore,
    root,
    isDev,
    debuggingPort,
    getSettings,
    aiService,
    emitProduct,
    onWindowCreated: (createdWindow) => { window = createdWindow; },
    onServicesCreated: (createdServices) => {
      window = createdServices.window;
      browser = createdServices.browser;
      automation = createdServices.automation;
      configureAutomation();
    },
  });
  window = services.window;
  browser = services.browser;
  automation = services.automation;
}

let configureAutomation: () => void = () => {};

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
  productStorage = createProductStorage({ db, store: appAuthStore, appVersion: () => app.getVersion(), settings: getSettings });
  const remoteProducts = productStorage.products;
  app.once("before-quit", productStorage.dispose);
  const copyRules = createTibetCopyRuleSync(appAuthStore, db);
  const syncCopyRules = () => { void copyRules.sync().catch(() => {}); };
  syncCopyRules();
  const copySyncTimer = setInterval(syncCopyRules, 60_000);
  copySyncTimer.unref();
  app.once("before-quit", () => clearInterval(copySyncTimer));
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
  productWorkflows = new ProductWorkflowCoordinator();
  updateService = new AppUpdateService({
    getWindow: () => window,
    onQuitAndInstall: () => { isQuittingForUpdate = true; },
  });
  const memoryService = new MemoryService({
    db,
    getOwnerUserId: vbkBindings.getExtensionUserId,
  });
  // 把 productEmitter 切换到 productStorage + remoteMirror 链
  installProductEmitter();
  db.recoverUnansweredMessages();
  const orphanProducts = db.recoverOrphanAutomationRuns();
  if (orphanProducts.length) logWarn("[startup] recovered orphan automation runs", { count: orphanProducts.length });
  const orphanPlanning = db.recoverOrphanPlanningStates();
  if (orphanPlanning.length) logWarn("[startup] recovered orphan planning runs", { count: orphanPlanning.length });
  const orphanLogs = db.recoverOrphanOperationLog();
  if (orphanLogs) logWarn("[startup] recovered interrupted log entries", { count: orphanLogs });
  const completedWorkflowTasks = db.completeSavedProductWorkflowTasks();
  if (completedWorkflowTasks.length) logWarn("[startup] reconciled completed product tasks", { count: completedWorkflowTasks.length });
  const orphanWorkflowTasks = db.recoverOrphanWorkflowTasks();
  if (orphanWorkflowTasks.length) logWarn("[startup] recovered interrupted product tasks", { count: orphanWorkflowTasks.length });

  const context: MainIpcContext = {
    db,
    get browser() { return browser ?? undefined; },
    get automation() { return automation ?? undefined; },
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
    // safeRemoveLegacyCiphertext 实际接收 (db, key) 双参；context 接口签名第一参是 VbkDatabase
    // 但调用方只传 key。包一层把 db 固定为本模块持有的 db 实例即可。
    safeRemoveLegacyCiphertext: ((key: string) => safeRemoveLegacyCiphertext(db, key)) as unknown as (db: VbkDatabase, key: string) => void,
    detectProviderIdInMain,
    emitProductIfKnown,
    logPoiManualIpc,
    memoryService,
    emitAgentSnapshot,
  };
  configureAutomation = installProductAgent(context);
  const memoryMaintenanceTimer = scheduleMemoryMaintenance(memoryService);
  app.once("before-quit", () => clearInterval(memoryMaintenanceTimer));
  const productTaskScheduler = new ProductTaskScheduler({
    db,
    get startPlanning() { return context.startPlanning!; },
    get resumePlanning() { return context.resumePlanning!; },
    get retryPlanning() { return context.retryPlanning!; },
    readiness,
    productWorkflows,
    get automation() { return automation ?? undefined; },
    emitTask: emitWorkflowTask,
    emitProduct,
  });
  context.enqueueProductTask = (product) => productTaskScheduler.enqueue(product);
  context.abandonProductTask = (taskId) => productTaskScheduler.abandon(taskId);
  context.resumeProductTask = (taskId, mode) => productTaskScheduler.resume(taskId, mode);
  registerMainIpc(context, appAuth, updateService, {
    onAuthenticated: async (user, source) => {
      syncCopyRules();
      await vbkBindings.onAuthenticated(user, source);
    },
  });
  await openMainWindow();
  updateService.scheduleStartupCheck();
  updateService.schedulePeriodicCheck();
  // 本地 renderer 已可交互；VBK 恢复与远端绑定同步在后台串接，失败不退出应用。
  browser!.initialise()
    .then(() => vbkBindings.afterBrowserReady())
    .then(async () => {
      if (!context.agentCore) return;
      const recovered = await recoverQueuedAgentWorkflowTasks({
        listWorkflowTasks: () => db!.listWorkflowTasks(),
        updateWorkflowTask: (id, patch) => db!.updateWorkflowTask(id, patch),
        getAgentSnapshot: (localProductId) => context.agentCore!.get(localProductId),
        resumeAgent: (localProductId) => context.agentCore!.resume(localProductId),
        emitWorkflowTask,
      });
      if (recovered.resumed || recovered.attention) {
        logWarn("[startup] recovered queued agent workflow tasks", recovered);
      }
    })
    .catch((error) => logWarn("[startup] deferred VBK binding restore failed", error));
  app.on("activate", () => {
    if (!BrowserWindow.getAllWindows().length) void openMainWindow();
  });
}).catch((error) => {
  logError(`${APP_NAME} 启动失败：`, error);
  app.quit();
});

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

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
let isDisposing = false;
app.on("before-quit", (event) => {
  db?.executionClock.dispose();
  if (isQuittingForUpdate) return;
  if (isDisposing || !browser) return;
  isDisposing = true;
  event.preventDefault();
  void browser.dispose().finally(() => app.exit(0));
});

// 让 TS 知道 ProductWorkflowTask 仍通过 events 模块被消费；
// 不导出类型避免外部污染 main 入口。
void ({} as ProductWorkflowTask);
