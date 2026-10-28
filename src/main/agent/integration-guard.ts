import type { AgentApproval, AgentSnapshot, ProductDetail } from '../../shared/contracts.js';
import { agentProductVersion, approvalForRun, buildAgentApproval, requiredAgentPhases } from './integration-gates.js';
import { ITINERARY_REVIEW_UNLOCK_SCOPE } from '../../shared/itinerary-review-approval.js';
import type { WizardStageRetryPhase } from '../../shared/wizard-stage-retry.js';

export class AgentAuthorizationError extends Error {
  readonly authorizationDenied = true;
}

const agentWritePhases = new Set([
  "saleControl", "basic", "presentation", "itinerary", "package",
  "pricingInventory", "hotelResource", "vehicleResource", "terms", "trafficLine", "preflight",
]);

/** Accept phase aliases emitted by older prompts without broadening the requested scope. */
export function normalizeAgentApprovalScope(product: ProductDetail, scope: string[]): string[] {
  const phases = new Set(requiredAgentPhases(product));
  const normalized = [...new Set(scope.map(item=>phases.has(item) ? `vbk.write_phase:${item}` : item))]
    // A saved product no longer needs its creation-shell phase. Narrowing this
    // stale scope is safe and prevents an old first-entry request from forcing
    // another operator retry before the current-plan approval card appears.
    .filter(item => !(product.productId && item === "vbk.write_phase:saleControl"));
  const current = buildAgentApproval(product).scope;
  if (current.includes(ITINERARY_REVIEW_UNLOCK_SCOPE)
    && current.filter(item => item !== ITINERARY_REVIEW_UNLOCK_SCOPE).every(item => normalized.includes(item))) {
    normalized.push(ITINERARY_REVIEW_UNLOCK_SCOPE);
  }
  return [...new Set(normalized)];
}

export function agentApprovalScopeError(
  product: ProductDetail,
  scope: string[],
  options: { allowSupersededPhases?: boolean; wizardStageRetry?: WizardStageRetryPhase } = {},
): string | undefined {
  const required = requiredAgentPhases(product).map(phase=>`vbk.write_phase:${phase}`);
  const wizardStageScope = options.wizardStageRetry && scope.length === 1
    && scope[0] === `vbk.write_phase:${options.wizardStageRetry}`;
  if (!wizardStageScope && required.some(item=>!scope.includes(item))) return `最终确认范围不完整。请将 read_product.requiredApprovalScope 原样用于 scope：${JSON.stringify(required)}。`;
  if (wizardStageScope && !required.includes(scope[0]!)) return `当前产品不支持向导阶段：${options.wizardStageRetry}。`;
  const reviewAllowed = buildAgentApproval(product).scope.includes(ITINERARY_REVIEW_UNLOCK_SCOPE);
  const isKnownScope = (item: string) => item.startsWith("vbk.write_phase:")
    && agentWritePhases.has(item.slice("vbk.write_phase:".length));
  if (scope.some(item=>!required.includes(item) && !(reviewAllowed && item === ITINERARY_REVIEW_UNLOCK_SCOPE)
    && (!options.allowSupersededPhases || !isKnownScope(item)))) {
    return `包含当前产品不支持的录入范围。当前 requiredApprovalScope：${JSON.stringify(required)}。`;
  }
}
/**
 * Describes lifecycle only. Write authority still requires the fingerprint
 * maintained by controlled product transactions; status cannot waive it.
 */
export function isDeterministicAutomationInFlight(
  product: ProductDetail,
  approvalIntentVersion: string | undefined,
  runIntentVersion: string | undefined,
): boolean {
  if (!approvalIntentVersion || approvalIntentVersion !== runIntentVersion) return false;
  const status = product.automation?.status;
  return status === 'running' || status === 'failed' || status === 'cancelled';
}

/** Run inside the browser lock, immediately before dispatching platform calls. */
/**
 * 已批准录入中天数被拒、转新建产品时，本轮重录需要新建产品壳。只有记录了
 * 同一批准 ID 且本地尚未绑定新产品时，才为该批准补出 saleControl。
 */
function replacementShellScope(product: ProductDetail, approval: AgentApproval): string[] {
  const replacement = product.automation?.durationReplacement;
  return !product.productId && replacement?.approvalId === approval.id ? ["vbk.write_phase:saleControl"] : [];
}

export function assertAgentWriteAuthorized(product: ProductDetail, snapshot: AgentSnapshot | undefined, phase: string, accountKey: string): void {
  const recorded = approvalForRun(snapshot);
  const approval = recorded && { ...recorded, scope: [...new Set([...recorded.scope, ...replacementShellScope(product, recorded)])] };
  if (!snapshot?.run || snapshot.run.status !== 'running' || snapshot.uncertainWrite) throw new AgentAuthorizationError('当前任务未处于可录入状态。');
  if (!approval || approval.intentVersion !== snapshot.run.intentVersion
    || approval.accountKey !== accountKey || !accountKey
    || (product.vbkAccount && product.vbkAccount !== accountKey)
    || !approval.scope.includes(`vbk.write_phase:${phase}`)) {
    throw new AgentAuthorizationError('方案、意图或账号已变化，请重新确认后录入。');
  }
  if (phase === "trafficLine" && approval.generateTrafficChildren !== true) {
    throw new AgentAuthorizationError("本次未授权生成子产品，请在产品录入页手动创建并录入子产品。");
  }
  if (approval.trafficChildrenOnly && !["trafficLine", "preflight"].includes(phase)) {
    throw new AgentAuthorizationError("本次仅授权子产品录入，不能重写母产品阶段。");
  }
  if (approval.wizardStageRetry && (approval.wizardStageRetry.alreadyAdvanced !== false || approval.wizardStageRetry.phase !== phase)) {
    throw new AgentAuthorizationError("本次仅授权当前向导页的官方下一步，不能执行其它阶段。");
  }
  const versionMatches = approval.productVersion === agentProductVersion(product);
  if (!versionMatches) {
    throw new AgentAuthorizationError('方案、意图或账号已变化，请重新确认后录入。');
  }
  const currentPhases = new Set(requiredAgentPhases(product));
  if (!currentPhases.has(phase)) throw new AgentAuthorizationError(`阶段 ${phase} 已不再是当前方案需要录入的范围。`);
  const scopeError = agentApprovalScopeError(product, approval.scope, {
    allowSupersededPhases: true,
    wizardStageRetry: approval.wizardStageRetry?.phase,
  });
  if (scopeError) throw new AgentAuthorizationError(scopeError);
}
