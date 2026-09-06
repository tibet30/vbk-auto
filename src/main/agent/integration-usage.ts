import type { AgentSnapshot, AiUsageEvent, ProductDetail } from '../../shared/contracts.js';
import { appendAiUsage } from '../ai/ai-usage-merge.js';
import type { VbkDatabase } from '../infrastructure/database/database.js';

export function withAgentUsage(product: ProductDetail, snapshot?: AgentSnapshot): ProductDetail {
  const events=(snapshot?.events ?? []).flatMap(event=>event.data?.aiUsage ? [event.data.aiUsage as AiUsageEvent] : []);
  return events.length ? {...product,aiUsage:appendAiUsage(product.aiUsage,events)} : product;
}
export function recordAgentUsage(db: VbkDatabase, localProductId: string, event: AiUsageEvent): void {
  const snapshot=db.getAgentSnapshot(localProductId);
  if (!snapshot?.run) return;
  snapshot.events.push({id:event.id,runId:snapshot.run.id,type:'status',createdAt:event.endedAt,
    content:'AI 已完成一次分析',data:{aiUsage:{...event,runId:snapshot.run.id}}});
  db.saveAgentSnapshot(snapshot);
}
