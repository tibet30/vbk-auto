import { normalisePoiIdentityName } from './poi-name-identity.js';
import { isKnownPoiNameAlias } from './poi-name-aliases.js';
import { requiresItineraryPoi } from './itinerary-activity-kind.js';

const compact = (value: string) => normalisePoiIdentityName(value).replace(/\p{Cf}/gu, '');

export function samePoiIdentityName(left: string, right: string): boolean {
  return compact(left) === compact(right) || isKnownPoiNameAlias(left, right);
}

/** Identity vetoes apply before best, AI, historical and manual selection alike. */
export function isCompatiblePoiIdentity(requested: string, candidate: string): boolean {
  const a = compact(requested), b = compact(candidate);
  if (!a || !b) return false;
  if (a === b || isKnownPoiNameAlias(a, b)) return true;
  if (isSubordinateTo(a, b) || isSubordinateTo(b, a)) return false;
  if (/[措错湖]$/u.test(a) && /[措错湖]$/u.test(b)) return false;
  // An independently named glacier is not the whole mountain containing it.
  if ((/(?:冰川群|冰川)$/u.test(a) && /(?:雪山|峰|山)$/u.test(b))
    || (/(?:冰川群|冰川)$/u.test(b) && /(?:雪山|峰|山)$/u.test(a))) return false;
  return true;
}

function isSubordinateTo(parent: string, child: string): boolean {
  const separated = /^(.*?)[-—–](.+)$/u.exec(child);
  if (separated && (separated[1] === parent || isKnownPoiNameAlias(parent, separated[1]))) return true;
  const parents = /[措错]$/u.test(parent) ? [parent.replace(/[措错]$/u, '措'), parent.replace(/[措错]$/u, '错')] : [parent];
  return parents.some(name => child.startsWith(name))
    && /(?:观景台|售票处|停车场|入口|出口|服务中心|[东西南北]门|[一二三四五六七八九十\d]+号(?:坑|门|展厅))$/u.test(child);
}

/** Saved IDs cannot bypass the same identity checks applied to current candidates. */
export function poiIdentityBlockers(product: Record<string, any>): Array<{ label: string; detail: string }> {
  return (Array.isArray(product.itinerary) ? product.itinerary : []).flatMap((day: any) =>
    (Array.isArray(day.spots) ? day.spots : []).filter((spot: any) => spot?.poiId
      && typeof spot?.poiName === 'string' && typeof spot?.name === 'string' && requiresItineraryPoi(spot)
      && !isCompatiblePoiIdentity(spot.name, spot.poiName)).map((spot: any) => ({
        label: `第${day.day}天景点身份：${spot.name}`,
        detail: '已保存 POI 与原景点身份或主子层级不符，须重新核验，不能沿用旧绑定或旧确认。',
      })));
}
