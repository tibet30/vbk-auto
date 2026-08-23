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
  ProductDetail,
  ProductReadiness,
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
  readiness: (localProductId: string) => ProductReadiness;
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
}
