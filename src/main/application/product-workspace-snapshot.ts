import type { ProductWorkspaceSnapshot } from '../../shared/contracts-product-architecture.js';
import type { ProductReadiness } from '../../shared/contracts.js';
import type { VbkDatabase } from '../infrastructure/database/database.js';
import { productExecutionView } from './product-execution-service.js';
import { agentDisplaySnapshot } from '../../shared/agent-display.js';
import { withAgentUsage } from '../agent/integration-usage.js';
import { toLegacyState } from '../planning/planning-state-projection.js';

/** Synchronous consistent read; neither task state nor approvals are modified. */
export function readProductWorkspaceSnapshot(db: VbkDatabase, id: string,
  readiness: (id: string) => ProductReadiness): ProductWorkspaceSnapshot {
  return db.runProductTransaction(() => {
    const product = db.getProduct(id);
    const owner = db.readLocalProductState(id)?.ownerUserId;
    if (!product || !owner) throw new Error('产品不存在或归属尚未确认。');
    const snapshot = db.getAgentSnapshot(id);
    const task = db.latestWorkflowTaskForProduct(id);
    return {
      ownerUserId: owner, localProductId: id, viewRevision: product.viewRevision ?? 0,
      product: { ...withAgentUsage(product, snapshot), workflowTask: task },
      execution: productExecutionView(product, snapshot, task), readiness: readiness(id),
      agent: snapshot ? agentDisplaySnapshot(snapshot) : undefined,
      planning: product.planning?.version === 2 ? toLegacyState(id, product.planning) : undefined,
    };
  });
}
