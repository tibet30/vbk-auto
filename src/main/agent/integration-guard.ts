import type { AgentSnapshot, ProductDetail } from '../../shared/contracts.js';
import { agentProductVersion, approvalForRun, requiredAgentPhases } from './integration-gates.js';

export class AgentAuthorizationError extends Error {
  readonly authorizationDenied = true;
}

const agentWritePhases = new Set([
  "saleControl", "basic", "presentation", "itinerary", "package",
  "pricingInventory", "hotelResource", "vehicleResource", "terms", "trafficLine", "preflight",
]);

/** Accept phase aliases emitted by older prompts without broadening the requested scope. */
export function normalizeAgentApprovalScope(product: ProductDetail, scope: string[]): string[] {
  const phases = new Set([...requiredAgentPhases(product), ...(product.productId ? ['saleControl'] : [])]);
  return [...new Set(scope.map(item=>phases.has(item) ? `vbk.write_phase:${item}` : item))];
}

export function agentApprovalScopeError(
  product: ProductDetail,
  scope: string[],
  options: { allowSupersededPhases?: boolean } = {},
): string | undefined {
  const required = requiredAgentPhases(product).map(phase=>`vbk.write_phase:${phase}`);
  if (required.some(item=>!scope.includes(item))) return `最终确认范围不完整。请将 read_product.requiredApprovalScope 原样用于 scope：${JSON.stringify(required)}。`;
  const isKnownScope = (item: string) => item.startsWith("vbk.write_phase:")
    && agentWritePhases.has(item.slice("vbk.write_phase:".length));
  if (scope.some(item=>!required.includes(item) && (!options.allowSupersededPhases || !isKnownScope(item)))) {
    return `包含当前产品不支持的录入范围。当前 requiredApprovalScope：${JSON.stringify(required)}。`;
  }
}
/** Run inside the browser lock, immediately before dispatching platform calls. */
export function assertAgentWriteAuthorized(product: ProductDetail, snapshot: AgentSnapshot | undefined, phase: string, accountKey: string): void {
  const approval = approvalForRun(snapshot);
  if (!snapshot?.run || snapshot.run.status !== 'running' || snapshot.uncertainWrite) throw new AgentAuthorizationError('当前任务未处于可录入状态。');
  if (!approval || approval.intentVersion !== snapshot.run.intentVersion
    || approval.productVersion !== agentProductVersion(product)
    || approval.accountKey !== accountKey || !accountKey
    || (product.vbkAccount && product.vbkAccount !== accountKey)
    || !approval.scope.includes(`vbk.write_phase:${phase}`)) throw new AgentAuthorizationError('方案、意图或账号已变化，请重新确认后录入。');
  const currentPhases = new Set(requiredAgentPhases(product));
  if (!currentPhases.has(phase)) throw new AgentAuthorizationError(`阶段 ${phase} 已不再是当前方案需要录入的范围。`);
  const scopeError = agentApprovalScopeError(product, approval.scope, {allowSupersededPhases:true});
  if (scopeError) throw new AgentAuthorizationError(scopeError);
}
