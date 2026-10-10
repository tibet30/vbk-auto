import { toPlatformShortLocationName } from './location-short-name.js';

/** Written only after a unique native district read; AI patches cannot write diagnostics. */
export function hasVerifiedRouteAdministrativeNode(product: Record<string, unknown>, name: string, day?: number): boolean {
  const diagnostics = record(product.diagnostics);
  const nodes = Array.isArray(diagnostics?.routeAdministrativeNodes) ? diagnostics.routeAdministrativeNodes : [];
  const target = toPlatformShortLocationName(name);
  return Boolean(target) && nodes.some(value => {
    const node = record(value);
    return node && toPlatformShortLocationName(node.name) === target
      && Number.isInteger(node.districtId) && Number(node.districtId) > 0
      && Number.isInteger(node.day) && Number(node.day) > 0 && (day === undefined || node.day === day);
  });
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
