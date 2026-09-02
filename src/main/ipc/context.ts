import type { DraftAutomation } from "../automation/automation.js";
import type { VbkBrowser } from "../infrastructure/vbk-browser.js";
import type { VbkDatabase } from "../infrastructure/database/database.js";
import type { LocalAiKeyStore } from "../infrastructure/ai-key-store.js";
import type { MiniMaxService } from "../minimax/minimax.js";
import type { ProductWorkflowCoordinator } from "../application/product-workflow-coordinator.js";
import type { ProductMutationService } from "../application/product-mutation-service.js";
import type { TibetProductService } from "../infrastructure/tibet-products.js";
import type { VbkBindingSync } from "../infrastructure/vbk-binding-sync.js";
import type {
  AiProvider,
  Planner,
  PlanningGenerationState,
  PlanningRunResult,
  ProductDetail,
  ProductReadiness,
  ProductWorkflowTask,
  WorkflowTaskRetryMode,
  Settings,
  VbkLoginStatus,
} from "../../shared/contracts.js";

/** Shared, explicitly injected dependencies for main-process IPC registrars. */
export interface MainIpcContext {
  db: VbkDatabase;
  browser: VbkBrowser;
  automation: DraftAutomation;
  aiKeyStore: LocalAiKeyStore;
  getSettings: () => Settings;
  apiKey: (provider?: AiProvider) => Promise<string>;
  aiService: (snapshot?: Settings) => Promise<MiniMaxService>;
  productWorkflows: ProductWorkflowCoordinator;
  productMutations: ProductMutationService;
  remoteProducts: TibetProductService;
  bindingSync: VbkBindingSync;
  getExtensionUserId: () => number | null;
  noteVbkAccountActive: (
    accountKey: string,
    meta?: { accountName?: string; providerId?: number | null },
  ) => void;
  readiness: (
    localProductId: string,
    options?: { ignoreInterruptedAutomationFailure?: boolean },
  ) => ProductReadiness;
  emitProduct: (product: ProductDetail) => void;
  /** Broadcast a snapshot already saved by Tibet; bypasses the local-write mirror. */
  broadcastProduct: (product: ProductDetail) => void;
  emitPlanningState: (state: PlanningGenerationState) => void;
  withKnownVbkAccount: (status: VbkLoginStatus) => VbkLoginStatus;
  completedPoiBackfillPlanner: (
    localProductId: string,
  ) => Promise<{ planner: Planner; providerLabel?: string }>;
  safeRemoveLegacyCiphertext: (db: VbkDatabase, key: string) => void;
  detectProviderIdInMain: () => Promise<number | null>;
  emitProductIfKnown: (accountName: string, info: unknown) => void;
  logPoiManualIpc: (event: string, context: Record<string, unknown>) => void;
  /** 新产品三阶段规划；由 planning IPC 注册后注入，供一键创建编排复用。 */
  startPlanning?: (localProductId: string) => Promise<PlanningRunResult>;
  /** 应用重启后的规划续跑；保留已完成节点，不重置 foundation。 */
  resumePlanning?: (localProductId: string) => Promise<PlanningRunResult>;
  /** 用户从规划报错处继续；只重置耗尽的失败节点，保留其余进度。 */
  retryPlanning?: (localProductId: string) => Promise<PlanningRunResult>;
  /** 一键创建只负责落任务；调度器在 renderer 请求结束后继续执行。 */
  enqueueProductTask?: (product: ProductDetail) => ProductWorkflowTask;
  /** 永久废弃后台任务；运行中任务会在安全检查点停止。 */
  abandonProductTask?: (taskId: string) => Promise<ProductWorkflowTask>;
  /** 从报错处继续，或从规划起点重新执行后台任务。 */
  resumeProductTask?: (taskId: string, mode: WorkflowTaskRetryMode) => Promise<ProductWorkflowTask>;
}
