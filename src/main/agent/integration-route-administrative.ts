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
  const result = await withPage(async () => normaliseNumberedRouteAdministrativeNodes(current, await getVbkRequestPage(deps.browser)));
  if (!result) return { current };
  const diagnostics = current.product.diagnostics as Record<string, unknown> | undefined;
  const receipts = Array.isArray(diagnostics?.routeAdministrativeNodes) ? diagnostics.routeAdministrativeNodes : [];
  deps.productMutations.replace(current.id, { ...current.product, itinerary: result.itinerary,
    diagnostics: { ...diagnostics, routeAdministrativeNodes: [...receipts, ...result.converted] },
  }, { status: current.status });
  const names = new Set(result.converted.map(item => item.name));
  deps.db.markResearchTasksSatisfied(current.id, current.researchTasks.filter(task =>
    [...names].some(name => task.label === `核查 ${name} 的 VBK POI 映射`)).map(task => task.id));
  return { current: deps.db.getProduct(current.id)!, converted: result.converted };
}
