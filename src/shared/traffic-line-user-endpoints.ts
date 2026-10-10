import { toPlatformShortLocationName } from "./location-short-name.js";

type Cities = { arrivalCity?: string; departureCity?: string };

/** 只读取用户明确的接送短句；途经城市、AI 行程和酒店不能决定交通端点。 */
export function explicitTrafficLineCities(product: Record<string, unknown>): Cities {
  const basic = record(product.basicInfo);
  const configured = record(record(product.operations).trafficLine);
  const clauses = text(basic.userIdea).split(/[\n;；，,。、]/u)
    .map((line) => line.trim().replace(/^(?:第\s*)?\d+\s*(?:天)?\s*[-、.:：]\s*/, ""));
  const hasTrafficScope = /大交通/u.test(text(basic.userIdea));
  const unique = (...patterns: RegExp[]): string | undefined => {
    const cities = [...new Set(clauses.flatMap((clause) => {
      const match = patterns.filter((_pattern, index) => index === 0 || hasTrafficScope)
        .map(pattern => clause.match(pattern)).find(Boolean);
      return match ? [toPlatformShortLocationName(match[1])] : [];
    }))];
    return cities.length === 1 ? cities[0] : undefined;
  };
  return {
    arrivalCity: toPlatformShortLocationName(configured.arrivalCity)
      || unique(/^([\p{Script=Han}]{2,10}?)\s*接(?:团|机|站|高铁|飞机|\s|[-—]|$)/u,
        /^(?:大交通\s*)?(?:抵达|到达)\s*([\p{Script=Han}]{2,10})$/u),
    departureCity: toPlatformShortLocationName(configured.departureCity)
      || unique(/^([\p{Script=Han}]{2,10}?)\s*(?:散团|送(?:飞机|高铁|机|站|团))/u,
        /^(?:大交通\s*)?离开\s*([\p{Script=Han}]{2,10})$/u),
  };
}

export function trafficLinePlanMatchesExplicitCities(product: Record<string, unknown>, plan: Cities | undefined): boolean {
  const cities = explicitTrafficLineCities(product);
  return (!cities.arrivalCity || cities.arrivalCity === toPlatformShortLocationName(plan?.arrivalCity))
    && (!cities.departureCity || cities.departureCity === toPlatformShortLocationName(plan?.departureCity));
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown): string { return typeof value === "string" ? value : ""; }
