import { ROUTE_DAY_MARKER } from './route-requirement-context.js';
import { constraintUserIdea } from './product-idea-optimization.js';
type Json = Record<string, any>;

/** Daily text supplied by the operator, never generated titles or POI metadata. */
export function originalOvernightRoute(product: Json, day: Json): string | undefined {
  let route = dailyRoute(constraintUserIdea(product.basicInfo), Number(day.day));
  for (const requirement of product.diagnostics?.routeRequirementMessages ?? []) {
    const revised = dailyRoute(requirement, Number(day.day));
    if (revised && /[-—–→]/u.test(revised)) route = revised;
    else if (!ROUTE_DAY_MARKER.test(requirement) || revised) route = undefined;
  }
  return route;
}

/**
 * Administrative receipts belong to the operator's original route, not to the
 * generated title/description or the current set of POI rows. Manual POI
 * selection, reclassification and deletion must therefore not stale every
 * administrative anchor on the day.
 */
export function routeLocationKey(product: Json, day: Json): string {
  return JSON.stringify([originalOvernightRoute(product, day), day.day]);
}

function dailyRoute(input: string, day: number): string | undefined {
  const raw = input.replace(/\\[nr]/gu, '\n');
  const marker = /(?:D(?:ay)?\s*([0-9一二三四五六七八九十]+)\s*(?:天|日)?|第\s*([0-9一二三四五六七八九十]+)\s*天|(?:^|\n)\s*(\d+)\s*[-、:：.])/giu;
  const matches = [...raw.matchAll(marker)];
  const index = matches.findIndex(match => dayNumber(match[1] ?? match[2] ?? match[3]) === day);
  if (index < 0) return undefined;
  const match = matches[index]!;
  return raw.slice(match.index! + match[0].length, matches[index + 1]?.index ?? raw.length).trim();
}

function dayNumber(value: string | undefined): number {
  if (!value) return NaN;
  if (/^\d+$/u.test(value)) return Number(value);
  const digits = '一二三四五六七八九';
  const [tens, units] = value.split('十');
  if (units === undefined) return digits.indexOf(value) + 1;
  return (tens ? digits.indexOf(tens) + 1 : 1) * 10 + (units ? digits.indexOf(units) + 1 : 0);
}
