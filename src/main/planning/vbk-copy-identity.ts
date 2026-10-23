import { hasCompletePoi } from "../../shared/itinerary-activity-kind.js";
import { originalOvernightRoute } from "../../shared/itinerary-overnight-city.js";

/** Entity names are data. Apply copy edits only outside complete identity names. */
export function isPoiIdentityPath(path: string): boolean {
  return /\.(?:poiName|requestedName)$/u.test(path)
    || /\.spots(?:\[\d+\]|\.\d+)\.name$/u.test(path);
}

export function poiIdentityNames(value: unknown, path = 'value'): string[] {
  const names = new Set<string>();
  const visit = (item: unknown, currentPath: string) => {
    if (typeof item === 'string' && isPoiIdentityPath(currentPath) && item.trim()) names.add(item.trim());
    else if (Array.isArray(item)) item.forEach((child, index) => visit(child, `${currentPath}[${index}]`));
    else if (item && typeof item === 'object') Object.entries(item).forEach(([key, child]) => visit(child, `${currentPath}.${key}`));
  };
  visit(value, path);
  return [...names].sort((a, b) => b.length - a.length);
}

/**
 * Names that may bypass presentation-copy checks. Unlike `poiIdentityNames`,
 * this never trusts arbitrary generated `spots[].name`: it requires a complete
 * POI binding, or proof that the name occurs in that day's original route.
 */
export function trustedPresentationPoiNames(product: unknown): string[] {
  if (!isRecord(product) || !Array.isArray(product.itinerary)) return [];
  const names = new Set<string>();
  for (const day of product.itinerary) {
    if (!isRecord(day) || !Array.isArray(day.spots)) continue;
    const originalRoute = originalOvernightRoute(product, day)?.replace(/\s+/gu, "") ?? "";
    for (const spot of day.spots) {
      if (!isRecord(spot) || spot.kind === "free" || spot.kind === "other") continue;
      const originalName = text(spot.name);
      if (hasCompletePoi(spot)) {
        addName(names, originalName);
        addName(names, text(spot.poiName));
      } else if (originalName && originalRoute.includes(originalName.replace(/\s+/gu, ""))) {
        addName(names, originalName);
      }
    }
  }
  return [...names].sort((left, right) => right.length - left.length);
}

function addName(names: Set<string>, name: string): void {
  if (name) names.add(name);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function outsidePoiNames(value: string, names: readonly string[], transform: (copy: string) => string): string {
  if (!names.length) return transform(value);
  const pattern = new RegExp(`(${names.map(name => name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('|')})`, 'gu');
  return value.split(pattern).map((part, index) => index % 2 ? part : transform(part)).join('');
}

export function hasOutsidePoiNameMatch(value: string, names: readonly string[], pattern: RegExp): boolean {
  let found = false;
  outsidePoiNames(value, names, copy => { if (pattern.test(copy)) found = true; return copy; });
  return found;
}
