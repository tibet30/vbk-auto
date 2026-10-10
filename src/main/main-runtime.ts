import type { AiProvider, Planner, ProductReadiness, Settings } from "../shared/contracts.js";
import { isAiProvider } from "../shared/contracts.js";
import { aiProviderConfig, aiProviderLabel as resolveAiProviderLabel } from "../shared/ai-provider-config.js";
import { resolveSystemNotificationsEnabled } from "../shared/system-notification-settings.js";
import { logWarn } from "../shared/log-timestamp.js";
import { inspectManualCoverAsset } from "./automation/manual-cover-asset.js";
import { evaluateVisibleReadiness } from "./planning/preparation-completion.js";
import { OpenAICompatiblePlannerAdapter, planningTransportOptions } from "./planning/adapters/openai-compatible-adapter.js";
import { MiniMaxService } from "./minimax/minimax.js";
import { productNotFound } from "./infrastructure/db-errors.js";
import { systemNotificationsSupported } from "./infrastructure/system-notifications.js";
import type { LocalAiKeyStore } from "./infrastructure/ai-key-store.js";
import type { VbkDatabase } from "./infrastructure/database/database.js";
import type { MemoryService } from "./memory/memory-service.js";
import { getVbkRequestPage } from "./infrastructure/vbk-request-page.js";
import { detectProviderIdFromBrowser } from "./infrastructure/provider-id-source.js";
import type { VbkBrowser } from "./infrastructure/vbk-browser.js";

export function safeRemoveLegacyCiphertext(db: VbkDatabase, key: string): void {
  try {
    if (!db.getSetting(key)) return;
    db.deleteSetting(key);
  } catch (error) {
    logWarn("[settings] failed to remove legacy cipher row", {
      key,
      message: (error as { message?: string })?.message ?? "unknown",
    });
  }
}

export function createMainAiRuntime(input: {
  getDb: () => VbkDatabase;
  getAiKeyStore: () => LocalAiKeyStore | null;
  dataPath: () => string;
  defaultMiniMaxModel: string;
}) {
  const getSettings = (): Settings => {
    const db = input.getDb();
    return ({
    aiProvider: isAiProvider(db.getSetting("aiProvider")?.value)
      ? db.getSetting("aiProvider")!.value as AiProvider
      : "minimax",
    minimaxBaseUrl: db.getSetting("minimaxBaseUrl")?.value || "https://api.minimaxi.com/v1",
    minimaxModel: db.getSetting("minimaxModel")?.value || input.defaultMiniMaxModel,
    deepseekBaseUrl: db.getSetting("deepseekBaseUrl")?.value || "https://api.evolink.ai/v1",
    deepseekModel: db.getSetting("deepseekModel")?.value || "deepseek-v4-flash",
    hasMiniMaxKey: input.getAiKeyStore()?.hasKey("minimax") ?? false,
    hasDeepSeekKey: input.getAiKeyStore()?.hasKey("deepseek") ?? false,
    systemNotificationsEnabled: resolveSystemNotificationsEnabled(db.getSetting("systemNotificationsEnabled")?.value),
    systemNotificationsSupported: systemNotificationsSupported(),
    dataPath: input.dataPath(),
  });
  };

  const apiKey = async (provider: AiProvider = getSettings().aiProvider): Promise<string> => {
    const store = input.getAiKeyStore();
    return store ? store.getKey(provider) : "";
  };

  const aiService = async (snapshot?: Settings): Promise<MiniMaxService> => {
    const settings = snapshot ?? getSettings();
    const deepSeek = settings.aiProvider === "deepseek";
    return new MiniMaxService({
      apiKey: await apiKey(settings.aiProvider),
      baseUrl: deepSeek ? settings.deepseekBaseUrl : settings.minimaxBaseUrl,
      model: deepSeek ? settings.deepseekModel : settings.minimaxModel,
      provider: settings.aiProvider,
    });
  };

  const completedPoiBackfillPlanner = async (
    localProductId: string,
  ): Promise<{ planner: Planner; providerLabel?: string }> => {
    const planner: Planner = {
      generateStage: async () => { throw new Error("已完成 POI 回填不应调用 AI planner"); },
    };
    const settings = getSettings();
    const hasActiveKey = settings.aiProvider === "deepseek" ? settings.hasDeepSeekKey : settings.hasMiniMaxKey;
    if (!hasActiveKey) return { planner };
    try {
      const providerProfile = aiProviderConfig(settings, settings.aiProvider);
      const resolverAdapter = new OpenAICompatiblePlannerAdapter({
        apiKey: await apiKey(settings.aiProvider),
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
  };

  return { getSettings, apiKey, aiService, completedPoiBackfillPlanner };
}

export function evaluateMainReadiness(
  db: VbkDatabase,
  localProductId: string,
  options: {
    ignoreInterruptedAutomationFailure?: boolean;
    ignoreCurrentAutomationFailure?: boolean;
  } = {},
): ProductReadiness {
  const product = db.getProduct(localProductId);
  if (!product) throw productNotFound(localProductId);
  const snapshot = db.getAgentSnapshot(localProductId);
  const visible = evaluateVisibleReadiness(product, snapshot, {
    ignoreInterruptedAutomationFailure: options.ignoreInterruptedAutomationFailure,
    ignoreCurrentAutomationFailure: options.ignoreCurrentAutomationFailure
      ?? Boolean(snapshot?.run && !snapshot?.uncertainWrite),
  });
  const issue = inspectManualCoverAsset(product.product).issue;
  if (!issue) return visible;
  const issues = [...visible.issues, { label: "封面图片规格", detail: issue }];
  return { ready: false, completion: Math.min(visible.completion, 92), issues };
}

export function scheduleMemoryMaintenance(memoryService: MemoryService): NodeJS.Timeout {
  const run = () => {
    try {
      const state = memoryService.settings();
      const lastSuccess = state.lastSuccessAt ? Date.parse(state.lastSuccessAt) : 0;
      const stale = !lastSuccess || Date.now() - lastSuccess >= 7 * 24 * 60 * 60 * 1000;
      if (state.pendingCount >= 30 || stale) memoryService.maintenance();
    } catch (error) {
      logWarn("[memory] maintenance skipped", error);
    }
  };
  queueMicrotask(run);
  return setInterval(run, 6 * 60 * 60 * 1000);
}

export function createProviderIdDetector(input: {
  getBrowser: () => VbkBrowser;
  getDb: () => VbkDatabase;
}): () => Promise<number | null> {
  return async () => {
    try {
      const id = await detectProviderIdFromBrowser(await getVbkRequestPage(input.getBrowser()));
      const db = input.getDb();
      const accountName = db.getSetting("vbkAccountName")?.value;
      if (id && accountName) db.setProviderIdFor(accountName, id);
      return id;
    } catch (error) {
      logWarn("[accounts] detectProviderId failed", error);
      return null;
    }
  };
}
