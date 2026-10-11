import type { VbkDatabase } from '../../src/main/infrastructure/database/database.js';
import { ProductMutationService } from '../../src/main/application/product-mutation-service.js';
import { ProductWorkflowCoordinator } from '../../src/main/application/product-workflow-coordinator.js';
import { installProductAgent } from '../../src/main/agent/integration-setup.js';
import { MiniMaxService } from '../../src/main/minimax/minimax.js';
import type { MainIpcContext } from '../../src/main/ipc/context.js';
import { evaluateMainReadiness } from '../../src/main/application/product-readiness.js';
import { inspectManualCoverAsset } from '../../src/main/automation/manual-cover-asset.js';
import { pngSize } from './isolation.js';
import { PRODUCT_PREPARATION_INSTRUCTION } from '../../src/main/agent/preparation-run.js';
import type { DraftAutomation } from '../../src/main/automation/automation.js';
import { createQueryReplay } from './query-replay.js';
import { loadGenerationReplay, installPlanningTransport, type GenerationReplay } from './generation-replay.js';
import { applyInitialOperatorInputs, operatorReplay } from './operator-replay.js';
import type { RegressionFixture, Json } from './corpus.js';
import { canonicalJson } from '../../src/shared/product-storage-projection.js';
import type { ProviderReplay } from './provider-replay.js';

export interface RegressionFaults {
  model?: GenerationReplay;
  /** Negative tests corrupt a persisted resource result before production confirmation. */
  corruptSaved?: (product: Json) => Json | undefined;
}
export async function runFullPreparation(db: VbkDatabase, fixture: RegressionFixture, dataPath: string,
  provider?: ProviderReplay, faults: RegressionFaults = {}) {
  const trace = faults.model ?? loadGenerationReplay(fixture.key);
  const transport = installPlanningTransport(trace);
  let corruptions = 0;
  try {
    const initial = db.createProduct(trace.input);
    if ((initial.product.itinerary as unknown[]).length || initial.product.presentation || initial.productId
      || db.getAgentSnapshot(initial.id)) throw new Error('必须从新建空白产品开始');
    const operators = operatorReplay(db, () => mutations, fixture, trace, dataPath);
    const checkpoints: Array<{ version: number; days: number; boundPois: number; hotelDays: number }> = [];
    const mutations = new ProductMutationService(db, updated => {
      const persisted = db.getProduct(updated.id)!;
      if (canonicalJson(persisted.product) !== canonicalJson(updated.product)) throw new Error('生产保存通知与数据库回读不一致');
      const days = persisted.product.itinerary as Array<Record<string, any>>;
      checkpoints.push({ version: persisted.productJsonVersion ?? 0, days: days.length,
        boundPois: days.flatMap(d => d.spots ?? []).filter(s => s.poiId).length,
        hotelDays: days.filter(d => d.hotelCandidates?.length).length });
      operators.onUpdated(persisted);
      const corrupted = faults.corruptSaved?.(structuredClone(db.getProduct(updated.id)!.product));
      if (corrupted) {
        mutations.replace(updated.id, corrupted, { notify: false, source: 'user',
          preserveVerifiedItineraryPois: false });
        corruptions++;
      }
    });
    applyInitialOperatorInputs(db, mutations, initial.id, trace);
    const queries = createQueryReplay(fixture, provider);
    const blockedWrites: string[] = [];
    const denyWrite = (name: string): never => { blockedWrites.push(name); throw new Error(`回归禁止携程写入：${name}`); };
    const automation = new Proxy({}, { get: (_target, key) => () => denyWrite(String(key)) }) as DraftAutomation;
    const inspectCover: typeof inspectManualCoverAsset = product => inspectManualCoverAsset(product, dataPath, pngSize);
    const context = {
      db, browser: queries.browser, automation, productMutations: mutations,
      productWorkflows: new ProductWorkflowCoordinator(),
      getSettings: () => ({ aiProvider: 'minimax', minimaxBaseUrl: 'https://model-replay.invalid/v1',
        minimaxModel: 'fixed-regression', hasMiniMaxKey: true, dataPath }),
      apiKey: async () => 'not-a-real-key',
      aiService: async () => new MiniMaxService({ apiKey: 'not-a-real-key',
        baseUrl: 'https://model-replay.invalid/v1', model: 'fixed-regression' }),
      // Isolated account readback boundary; production account/fingerprint checks still execute.
      remoteProducts: { get: async (id: string) => db.getProduct(id)! },
      readiness: (id: string, options?: Parameters<typeof evaluateMainReadiness>[2]) =>
        evaluateMainReadiness(db, id, options, inspectCover),
      emitProduct: () => {},
    } as unknown as MainIpcContext;
    installProductAgent(context, queries.queries, inspectCover);
    const core = context.agentCore!;
    await core.send(initial.id, `${trace.operatorInstructions}\n${PRODUCT_PREPARATION_INSTRUCTION}\n${trace.input.userIdea}`);
    await core.idle(initial.id);
    return { initial, trace, saved: db.getProduct(initial.id)!, snapshot: await core.get(initial.id),
      stages: transport.stages, modelMisses: transport.misses, queries: queries.calls, misses: queries.misses,
      operators: operators.actions, blockedWrites, checkpoints, corruptions };
  } finally { transport.restore(); }
}
