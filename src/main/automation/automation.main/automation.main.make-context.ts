import { ProductMutationService } from "../../application/product-mutation-service.js";
import type { AutomationRunContext } from "./automation.main.context.js";
import { ensureBrowserHasBounds, markCancelled, resolveActiveButlerContext } from "./automation.main.class.helpers.js";
import { PlatformOperationService } from '../../application/platform-operation-service.js';
import { AutomationCancelledError } from './automation.main.errors.js';

export function makeAutomationRunContext(args: Pick<AutomationRunContext,
  "db" | "browser" | "emit" | "advisor" | "presentationCopyRewriter" | "disambiguator" | "cancellationRequested">
  & { localProductId?: string; guard?: AutomationRunContext["assertWriteAuthorized"]; mutations?: ProductMutationService;
    exclusive: <T>(task: () => Promise<T>) => Promise<T> }): AutomationRunContext {
  const baselines = new Map<string, NonNullable<ReturnType<typeof args.db.getProduct>>>();
  if (args.localProductId) {
    const initial = args.db.getProduct(args.localProductId);
    if (initial) baselines.set(initial.id, initial);
  }
  return {
    db: args.db, browser: args.browser, emit: args.emit,
    agentControlled: Boolean(args.localProductId && args.guard),
    assertWriteAuthorized: args.localProductId ? args.guard : undefined,
    advisor: args.localProductId && args.guard
      ? async () => ({ summary: "阶段未完成", rootCause: "等待 Agent 根据执行结果决定后续动作", action: "wait_for_user", expectedEvidence: "权威回读结果", userInstruction: "已将错误返回 Agent，未在工具内部重复写入。" })
      : args.advisor,
    presentationCopyRewriter: args.presentationCopyRewriter,
    disambiguator: args.disambiguator,
    resolveActiveButlerContext: accountName => resolveActiveButlerContext(args.db, accountName),
    markCancelled: (_id, run, persist) => markCancelled(run, persist),
    cancellationRequested: args.cancellationRequested,
    ensureBrowserHasBounds: () => ensureBrowserHasBounds(args.browser),
    persistProduct: (id, product, status) => {
      const current = args.db.getProduct(id);
      if (!current) throw new Error('产品不存在');
      const saved = (args.mutations ?? new ProductMutationService(args.db)).commands.mergeChanges(
        id, baselines.get(id) ?? current, product, 'automation', { status, notify: false });
      baselines.set(id, saved);
    },
    runVbkPageExclusive: (task, phase) => args.exclusive(async () => {
      if (!args.localProductId || !phase) return task();
      const id = args.localProductId;
      const product = args.db.getProduct(id);
      const service = new PlatformOperationService((evidence, status) => args.db.recordResourceObservation?.(id, { ...evidence, status }));
      try { return await service.write({ capability: `write_phase:${phase}`, query: { productId: product?.productId, phase },
        source: 'vbk', accountKey: product?.vbkAccount }, async () => {
        if (args.cancellationRequested.has(id)) throw new AutomationCancelledError();
        await args.guard?.(id, phase);
      }, task); } catch (error) {
        if ((error as { uncertainWrite?: boolean })?.uncertainWrite) {
          const snapshot = args.db.getAgentSnapshot?.(id);
          if (snapshot) {
            snapshot.uncertainWrite = { toolCallId: `phase:${phase}`, message: (error as Error).message,
              createdAt: new Date().toISOString() };
            args.db.saveAgentSnapshot(snapshot);
          }
        }
        throw error;
      }
    }),
  };
}
