import { isKnownPoiNameAlias } from './poi-name-aliases.js';
import { originalOvernightRoute } from './original-itinerary-route.js';

type Json = Record<string, any>;
const compact = (value: string) => value.replace(/\s+/gu, '').trim();

export function poiRouteIdentityCore(value: string): string {
  return compact(value).replace(/^远眺/u, '').replace(/措$/u, '错')
    .replace(/(?:山体冰川遗迹|冰川遗迹|冰川群|冰川|雪山)$/u, '');
}

/** 景区类别尾缀只是同类地貌的目录称谓，不改变原名对应的地点身份。 */
function withoutScenicSuffix(value: string): string {
  return compact(value).replace(/(?:旅游景区|风景名胜区|风景区|景区|地质公园)$/u, '');
}

/**
 * 运营原文与目录官方名的等价关系，仅用于判断“原文是否已明确这个地点”的就绪证据。
 * 与 `isKnownPoiNameAlias` 分开：这里不参与候选选择，避免为结清待处理项而新开自动选择。
 */
const evidenceNameGroups = [
  /^(?:洛子峰|洛子[Ii]峰)$/u,
  /^(?:五彩沙丘|仲巴五彩沙漠|仲巴县五彩沙漠)$/u,
];

/** 仅这两个产品别名由原路线证据承认；不并进 isKnownPoiNameAlias 以影响选点。 */
export function isOriginalRoutePoiAlias(left: string, right: string): boolean {
  return evidenceNameGroups.some((group) => group.test(left) && group.test(right));
}

/** Current operator text, rather than a generated title or old binding, names this identity. */
export function hasOriginalPoiNameEvidence(product: Json, day: Json, keyword: string, poiName: string): boolean {
  const route = compact(originalOvernightRoute(product, day) ?? '');
  const name = compact(keyword);
  if (!name || !route.includes(name)) return false;
  const official = compact(poiName);
  const core = poiRouteIdentityCore(name);
  const bare = withoutScenicSuffix(name);
  return name === official || isKnownPoiNameAlias(name, poiName) || isOriginalRoutePoiAlias(name, official)
    || (bare.length >= 2 && bare === withoutScenicSuffix(official))
    || (core.length >= 4 && core === poiRouteIdentityCore(official));
}
