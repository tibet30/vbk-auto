import { installProductAgent } from "./agent/integration-setup.js";
import { withAgentUsage } from "./agent/integration-usage.js";
import { agentWorkflowPatch, recoverQueuedAgentWorkflowTasks } from "./agent/integration-workflow.js";
/** Electron main process entry and application bootstrap. */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow } from "electron";
import { installLogSink, logError, logInfo, logWarn } from "../shared/log-timestamp.js";
import { createRuntimeLogCapture } from "../shared/log-redaction.js";
import { APP_NAME } from "../shared/brand.js";
import type {
  PlanningGenerationState,
  ProductDetail,
} from "../shared/contracts.js";
import { DraftAutomation } from "./automation/automation.js";
import { VbkDatabase } from "./infrastructure/database/database.js";
import { safeRendererSend } from "./infrastructure/renderer-send.js";
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
import { agentDisplaySnapshot } from "../shared/agent-display.js";
import { ProductTaskScheduler } from "./application/product-task-scheduler.js";
import type { ProductWorkflowTask } from "../shared/contracts.js";
import type { MainIpcContext } from "./ipc/context.js";
import { ProductWorkflowCoordinator } from "./application/product-workflow-coordinator.js";
import { ProductMutationService } from "./application/product-mutation-service.js";
import { AppUpdateService } from "./application/app-update-service.js";
import { createRemoteProductMirror } from "./application/remote-product-mirror.js";
import { mergeAgentDiagnostics } from "./application/product-diagnostics.js";
import { applyAppMetadata, applyDevDockIcon, installApplicationMenu } from "./app-branding.js";
import { cleanStaleChromiumProfileDb } from "./infrastructure/chromium-profile-cleanup.js";
import { createWithKnownVbkAccount } from "./infrastructure/vbk-account-status.js";
import { createVbkBindingBootstrap } from "./infrastructure/vbk-binding-bootstrap.js";
import { captureRuntimeLog, setOperationLogDb } from "./operations/operation-log-store.js";
import { agentAttentionNotification } from "./infrastructure/agent-attention-notification.js";
import { createAttentionNotificationDelivery } from "./infrastructure/attention-notification-delivery.js";
import { showSystemNotification, systemNotificationsSupported } from "./infrastructure/system-notifications.js";
import { workflowAttentionNotification } from "./infrastructure/workflow-attention-notification.js";
import { MemoryService } from "./memory/memory-service.js";
import {
  createMainAiRuntime,
  createProviderIdDetector,
  evaluateMainReadiness,
  safeRemoveLegacyCiphertext,
  scheduleMemoryMaintenance,
} from "./main-runtime.js";
import { registerMainIpc } from "./main-ipc.js";
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

const userDataDirOverride = process.env.VBK_USER_DATA_DIR?.trim();
if (userDataDirOverride) {
  app.setPath("userData", userDataDirOverride);
}

let window: BrowserWindow;
let db: VbkDatabase;
let browser: VbkBrowser;
let automation: DraftAutomation;
let updateService: AppUpdateService;
let isQuittingForUpdate = false;
const deliverAgentAttention = createAttentionNotificationDelivery({
  supported: systemNotificationsSupported,
  show: showSystemNotification,
  onFailure: (message) => logWarn("[agent] system notification failed", { message }),
});
const deliverWorkflowAttention = createAttentionNotificationDelivery({
  supported: systemNotificationsSupported,
  show: showSystemNotification,
  onFailure: (message) => logWarn("[workflow] system notification failed", { message }),
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
/**
 * Local AI API key store. One instance per process; backed by a single
 * 0600 JSON file under `app.getPath('userData')` (see ai-key-store.ts).
 * Must be created *after* `app.whenReady()` so `userData` is available;
 * main.ts initialises this in `bootstrap()` together with the database.
 */
let aiKeyStore: LocalAiKeyStore | null = null;
const {
  getSettings,
  apiKey,
  aiService,
  completedPoiBackfillPlanner,
} = createMainAiRuntime({
  getDb: () => db,
  getAiKeyStore: () => aiKeyStore,
  dataPath: () => app.getPath("userData"),
  defaultMiniMaxModel,
});
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
  product = withAgentUsage(product, db?.getAgentSnapshot(product.id));
  const completedTask = db?.completeWorkflowTaskForProduct(product);
  if (completedTask) emitWorkflowTask(completedTask);
  // 任务可能已被 products:get / workflowTasks:list 等读取路径提前收敛为成功，
  // 此时 completedTask 会是 undefined，不能再依赖单独的 task event 刷新详情页。
  // 对已保存草稿，把本机权威任务快照原子地附在 product:updated 上，避免详情页
  // 因事件先后或订阅时机继续显示旧的失败 / 等待状态。
  const workflowTask = product.status === "draft_saved" && product.productId
    ? db?.latestWorkflowTaskForProduct(product.id)
    : undefined;
  const nextProduct = workflowTask ? { ...product, workflowTask } : product;
  safeRendererSend(window, "product:updated", nextProduct);
};
let productEmitter: (product: ProductDetail) => void = broadcastProduct;
const emitProduct = (product: ProductDetail) => productEmitter(product);
/**
 * 规划状态在成功落库后才广播。该事件是 renderer 的实时来源；首次打开产品
 * 仍通过 planning:state 补偿，避免订阅建立前的事件丢失。
 */
const emitPlanningState = (state: PlanningGenerationState) => {
  // 状态已落库；renderer 重建期间由 planning:state 读取路径补偿。
  safeRendererSend(window, "planning:updated", state.localProductId, state);
};
const emitWorkflowTask = (task: ProductWorkflowTask, notify = true) => {
  const attention = notify ? workflowAttentionNotification(task) : null;
  if (getSettings().systemNotificationsEnabled && attention) {
    void deliverWorkflowAttention(task.id, { ...attention, title: `${APP_NAME} · ${attention.title}` });
  }
  // 任务已持久化；窗口恢复后 workflowTasks:list 会补偿事件丢失。
  safeRendererSend(window, "workflow-task:updated", task);
};
const emitAgentSnapshot = (snapshot: import("../shared/contracts.js").AgentSnapshot) => {
  const attention = agentAttentionNotification(snapshot, db?.getProduct(snapshot.localProductId)?.name ?? "方案");
  if (getSettings().systemNotificationsEnabled && attention) {
    void deliverAgentAttention(snapshot.localProductId, { ...attention, title: `${APP_NAME} · ${attention.title}` });
  }
  if (snapshot.run) {
    let task = db?.latestWorkflowTaskForProduct(snapshot.localProductId);
    const product = db?.getProduct(snapshot.localProductId);
    if (product && (!task || (['abandoned','succeeded','failed','cancelled'].includes(task.status)
      && snapshot.run.createdAt > task.updatedAt))) {
      task = db.createWorkflowTask(product.id, product.name);
    }
    if (task && (task.status !== "abandoned" || snapshot.run.status === "abandoned")) {
      emitWorkflowTask(db.updateWorkflowTask(task.id, agentWorkflowPatch(snapshot, product)), false);
    }
    const latestProduct = db?.getProduct(snapshot.localProductId);
    if (latestProduct) {
      db.updateProduct(
        latestProduct.id,
        mergeAgentDiagnostics(latestProduct, snapshot),
        latestProduct.status,
        latestProduct.productJsonVersion,
      );
      const saved = db.getProduct(latestProduct.id);
      if (saved) emitProduct(saved);
    }
  }
  safeRendererSend(window, "agent:updated", agentDisplaySnapshot(snapshot));
};
const readiness = (
  localProductId: string,
  options: Parameters<typeof evaluateMainReadiness>[2] = {},
) => evaluateMainReadiness(db, localProductId, options);

const detectProviderIdInMain = createProviderIdDetector({
  getBrowser: () => browser,
  getDb: () => db,
});

function emitProductIfKnown(_accountName: string, _info: unknown): void {
  // Reserved for future account-fixed-info renderer notifications.
}

let configureAutomation: () => void = () => {};

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
      configureAutomation();
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
  const productStorage = createProductStorage({ db, store: appAuthStore, appVersion: () => app.getVersion(), settings: getSettings });
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
  const productWorkflows = new ProductWorkflowCoordinator();
  updateService = new AppUpdateService({
    getWindow: () => window,
    onQuitAndInstall: () => { isQuittingForUpdate = true; },
  });
  const memoryService = new MemoryService({
    db,
    getOwnerUserId: vbkBindings.getExtensionUserId,
  });
  const mirrorProduct = createRemoteProductMirror({
    remote: remoteProducts,
    broadcast: broadcastProduct,
    isWorkflowActive: (productId) => Boolean(productWorkflows.activeWorkflow(productId)),
    // 本机自动录入进展即时显示；诊断上传与产品保存互不阻塞。
    shouldBroadcastWhileActive: (productId) => productWorkflows.activeWorkflow(productId) === "automation" || Boolean(db.getAgentSnapshot(productId)?.run),
  }).emit;
  productEmitter = product => {
    productStorage.observe(product);
    mirrorProduct(product);
  };
  db.recoverUnansweredMessages();
  const orphanProducts = db.recoverOrphanAutomationRuns();
  if (orphanProducts.length) logWarn("[startup] recovered orphan automation runs", { count: orphanProducts.length });
  const orphanPlanning = db.recoverOrphanPlanningStates();
  if (orphanPlanning.length) logWarn("[startup] recovered orphan planning runs", { count: orphanPlanning.length });
  const orphanLogs = db.recoverOrphanOperationLog();
  if (orphanLogs) logWarn("[startup] recovered interrupted log entries", { count: orphanLogs });
  const completedWorkflowTasks = db.completeSavedProductWorkflowTasks();
  if (completedWorkflowTasks.length) logInfo("[startup] reconciled completed product tasks", { count: completedWorkflowTasks.length });
  const orphanWorkflowTasks = db.recoverOrphanWorkflowTasks();
  if (orphanWorkflowTasks.length) logWarn("[startup] recovered interrupted product tasks", { count: orphanWorkflowTasks.length });

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
    memoryService,
    emitAgentSnapshot,
  };
  configureAutomation = installProductAgent(context);
  const memoryMaintenanceTimer = scheduleMemoryMaintenance(memoryService);
  app.once("before-quit", () => clearInterval(memoryMaintenanceTimer));
  const productTaskScheduler = new ProductTaskScheduler({
    db,
    get startPlanning() { return context.startPlanning; },
    get resumePlanning() { return context.resumePlanning; },
    get retryPlanning() { return context.retryPlanning; },
    readiness,
    productWorkflows,
    get automation() { return automation; },
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
  void browser.initialise()
    .then(() => vbkBindings.afterBrowserReady())
    .then(async () => {
      if (!context.agentCore) return;
      const recovered = await recoverQueuedAgentWorkflowTasks({
        listWorkflowTasks: () => db.listWorkflowTasks(),
        updateWorkflowTask: (id, patch) => db.updateWorkflowTask(id, patch),
        getAgentSnapshot: (localProductId) => context.agentCore!.get(localProductId),
        resumeAgent: (localProductId) => context.agentCore!.resume(localProductId),
        emitWorkflowTask,
      });
      if (recovered.resumed || recovered.attention) {
        logInfo("[startup] recovered queued agent workflow tasks", recovered);
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
