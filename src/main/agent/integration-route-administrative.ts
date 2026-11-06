import type { ProductDetail } from '../../shared/contracts.js';
import type { AgentBusinessDependencies } from './integration-generate.js';
import { normaliseNumberedRouteAdministrativeNodes } from '../planning/numbered-route-administrative.js';
import { getVbkRequestPage } from '../infrastructure/vbk-request-page.js';

/** Keep native district evidence and the resulting local itinerary in one write. */
export async function resolveAdministrativeRouteNodes(
  current: ProductDetail,
  deps: AgentBusinessDependencies,
  withPage: <T>(work: () => Promise<T>) => Promise<T>,
): Promise<{ current: ProductDetail; converted?: Array<{ day: number; name: string; districtId: number }> }> {
  if (!deps.browser) return { current };
  // Agent 对话里的运营要求（「第四天要有九寨沟的景区」）只存在快照事件中。
  const agentMessages = (deps.db.getAgentSnapshot?.(current.id)?.events ?? []).filter(event => event.type === 'user')
    .map(event => ({ role: 'user' as const, content: event.content }));
  const result = await withPage(async () => normaliseNumberedRouteAdministrativeNodes(current, await getVbkRequestPage(deps.browser), agentMessages));
  if (!result) return { current };
  const diagnostics = current.product.diagnostics as Record<string, unknown> | undefined;
  const receipts = Array.isArray(diagnostics?.routeAdministrativeNodes) ? diagnostics.routeAdministrativeNodes : [];
  deps.productMutations.commands.mergeChanges(current.id, current, { ...current.product, itinerary: result.itinerary,
    diagnostics: { ...diagnostics, routeAdministrativeNodes: [...receipts, ...result.converted], routeLocations: result.locations },
  }, 'resource', { status: current.status });
  const names = new Set(result.converted.map(item => item.name));
  deps.db.markResearchTasksSatisfied(current.id, current.researchTasks.filter(task =>
    [...names].some(name => task.label === `核查 ${name} 的 VBK POI 映射`)).map(task => task.id));
  return { current: deps.db.getProduct(current.id)!, converted: result.converted };
}
