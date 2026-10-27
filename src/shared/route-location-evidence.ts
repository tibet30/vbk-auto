import { originalOvernightRoute } from './original-itinerary-route.js';
import { toPlatformShortLocationName } from './location-short-name.js';
import { orderedItineraryRoutePath } from './itinerary-route-path.js';
import { hasOriginalPoiNameEvidence } from './poi-original-route-identity.js';
import { corridorDistanceKm, geoPoint, ROUTE_CORRIDOR_RADIUS_KM } from './route-corridor.js';

type Json = Record<string, any>;
export interface RouteLocation {
  province: string;
  city: string;
  district?: string;
  /** Both sides of this stop have independently verified administrative anchors. */
  bounded?: boolean;
}
export interface RouteLocationEvidence extends RouteLocation {
  day: number;
  name: string;
  districtId: number;
  position: number;
  sourceRoute: string;
  routeKey: string;
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

/** Only native administrative receipts for the current route may expand geography. */
export function currentRouteLocations(product: Json, day: Json): RouteLocationEvidence[] {
  const source = originalOvernightRoute(product, day);
  if (!source) return [];
  const values = product.diagnostics?.routeLocations;
  return (Array.isArray(values) ? values : []).filter((node: RouteLocationEvidence) =>
    node && node.day === Number(day.day) && node.sourceRoute === source
    // New receipts use the stable key. Older receipts used mutable generated
    // day fields; exact sourceRoute + native district identity is the safe
    // compatibility boundary for those already-persisted products.
    && Boolean(node.routeKey)
    && Number.isInteger(node.districtId) && node.districtId > 0 && node.province && node.city
    && Number.isInteger(node.position) && node.position >= 0
    && source.slice(node.position).startsWith(node.name));
}

/**
 * A route stop is a whole segment of the operator's original path. A name that only
 * occurs inside a longer segment (「雪乡」inside「雪乡轻旅拍体验」/「雪乡夜景」) is not
 * that stop and must not vote on the day's geography. Ambiguous repeats stay unknown.
 */
function routeStopPosition(path: string, keyword: string): number | undefined {
  const name = keyword.trim();
  if (!name) return undefined;
  // 「+」是同日同位置的并列站点分隔符（冈仁波齐+玛旁雍措+拉昂措），不是站名的一部分。
  const boundary = (character: string | undefined) =>
    character === undefined || /[-—–→+＋>＞，,、/／（(【:：&＆\s]/u.test(character);
  const positions: number[] = [];
  for (let index = path.indexOf(name); index >= 0; index = path.indexOf(name, index + name.length)) {
    if (boundary(path[index - 1]) && boundary(path[index + name.length])) positions.push(index);
  }
  return positions.length === 1 ? positions[0] : undefined;
}

/** A stop sees only the adjacent route anchors, never all cities visited that day. */
export function routeLocationsForSpot(product: Json, day: Json, keyword: string): RouteLocation[] {
  const source = originalOvernightRoute(product, day);
  if (!source || !keyword || !Array.isArray(day.spots)) return [];
  if (!currentSpotOrderPreserved(source, day.spots)) return [];
  const spot = day.spots.find((value: Json) => value?.name === keyword);
  if (!spot) return [];
  const path = orderedItineraryRoutePath(source);
  const position = routeStopPosition(path, keyword);
  if (position === undefined) return [];
  const nodes = currentRouteLocations(product, day).filter(node => node.position < path.length).sort((a, b) => a.position - b.position);
  const before = nodes.filter(node => node.position <= position).at(-1);
  const after = nodes.find(node => node.position >= position);
  const adjacent = [before, after].filter((value): value is RouteLocationEvidence => Boolean(value));
  // A route through a county does not locate every intervening attraction in that county.
  const bounded = Boolean(before && after);
  return [...new Map(adjacent.map(node => [JSON.stringify([node.province, node.city]),
    { province: node.province, city: node.city, bounded }])).values()];
}

/** Deleting/reclassifying a row preserves the remaining subsequence; reordering does not. */
function currentSpotOrderPreserved(source: string, spots: Json[]): boolean {
  const path = orderedItineraryRoutePath(source);
  const positions = spots.flatMap((spot) => {
    const position = routeStopPosition(path, textValue(spot?.name));
    return position === undefined ? [] : [position];
  });
  return positions.every((position, index) => index === 0 || position >= positions[index - 1]!);
}

export function routeLocationMatches(candidate: Json, location: RouteLocation): boolean {
  const short = toPlatformShortLocationName;
  return short(candidate.province) === location.province && short(candidate.city) === location.city
    && (!location.district || short(candidate.district) === location.district);
}

export function routeLocationsForKeyword(product: Json, keyword: string, dayNumber?: number): RouteLocation[] {
  const days = (Array.isArray(product.itinerary) ? product.itinerary : []).filter((day: Json) =>
    (dayNumber === undefined || Number(day.day) === dayNumber)
    && (Array.isArray(day?.spots) ? day.spots : []).some((spot: Json) => spot?.name === keyword));
  if (days.length !== 1) return [];
  return routeLocationsForSpot(product, days[0], keyword);
}

/** Runs again against saved facts, including mappings whose old research task was confirmed. */
export function routeLocationBlockers(product: Json): Array<{ label: string; detail: string }> {
  const issues: Array<{ label: string; detail: string }> = [];
  const province = toPlatformShortLocationName(product.basicInfo?.province);
  for (const day of Array.isArray(product.itinerary) ? product.itinerary : []) {
    for (const spot of Array.isArray(day?.spots) ? day.spots : []) {
      if (!spot?.poiId || !spot.poiName) continue;
      const locations = routeLocationsForSpot(product, day, spot.name);
      const crossProvince = province && spot.province && toPlatformShortLocationName(spot.province) !== province;
      const receipts = product.diagnostics?.routeLocations;
      const hadRouteEvidence = (Array.isArray(receipts) ? receipts : []).some((node: RouteLocationEvidence) => node?.day === Number(day.day));
      // 未落在有序路线上的「看点」没有相邻锚点，只能用同省 + 原文点名作证；
      // 一旦有相邻路线锚点，就必须匹配它的城市，避免同日途经城市替错绑背书。
      // 同一城市的双侧锚点构成明确约束；单侧或跨城市锚点不能排除中途跨城。
      const spotProvince = toPlatformShortLocationName(spot.province);
      const spotCity = toPlatformShortLocationName(spot.city);
      const sameProvince = locations.length > 0 && Boolean(spotProvince)
        && locations.every(location => toPlatformShortLocationName(location.province) === spotProvince);
      const singleBoundedCity = locations.length === 1 && locations[0]?.bounded;
      // 有相邻锚点却不在锚点城市：同省 + 原文点名不足以证明地点，还必须有
      // 已持久化坐标落在当日路线走廊内的正面证据。
      const namedSameProvince = Boolean(spotProvince) && Boolean(spotCity)
        && (!province || spotProvince === province)
        && currentRouteLocations(product, day).length > 0
        && hasOriginalPoiNameEvidence(product, day, spot.name, spot.poiName)
        && (locations.length === 0
          || (sameProvince && !singleBoundedCity && corridorProvesLocation(product, Number(day.day), spot)));
      const explicitRoute = locations.length === 0 && hasExplicitOriginalRouteLocation(product, day, spot);
      if ((locations.length || crossProvince || hadRouteEvidence) && !namedSameProvince && !explicitRoute
        && !locations.some(location => routeLocationMatches(spot, location))) {
        issues.push({ label: `第${day.day}天景点地域：${spot.name}`,
          detail: '已保存 POI 的地域缺少当前原路线及平台行政区核验证据，需重新核验或明确行程地点。' });
      }
    }
  }
  return issues;
}

/** 当日（含前后一天）落在行政锚点城市、且带平台坐标的已绑定 POI，按行程顺序。 */
function corridorReferences(product: Json, dayNumber: number, excludePoiId: number) {
  const days = (Array.isArray(product.itinerary) ? product.itinerary : [])
    .filter((day: Json) => Math.abs(Number(day?.day) - dayNumber) <= 1)
    .sort((left: Json, right: Json) => Number(left.day) - Number(right.day));
  return days.flatMap((day: Json) => {
    const anchors = currentRouteLocations(product, day);
    return (Array.isArray(day.spots) ? day.spots : []).flatMap((spot: Json) => {
      const poiId = Number(spot?.poiId);
      const point = geoPoint(spot);
      if (!point || !Number.isInteger(poiId) || poiId <= 0 || poiId === excludePoiId) return [];
      return anchors.some(anchor => routeLocationMatches(spot, { province: anchor.province, city: anchor.city }))
        ? [point] : [];
    });
  });
}

/**
 * 跨城地点证据：候选坐标到锚点已确认 POI 折线的距离不超过走廊半径。
 * 只读平台返回并持久化的坐标，可在回读时离线重算；缺坐标即不成立。
 */
export function corridorProvesLocation(product: Json, dayNumber: number, candidate: Json): boolean {
  const point = geoPoint(candidate);
  if (!point) return false;
  const distance = corridorDistanceKm(point, corridorReferences(product, dayNumber, Number(candidate.poiId)));
  return distance !== undefined && distance <= ROUTE_CORRIDOR_RADIUS_KM;
}

/**
 * 旧产品没有 diagnostics.routeLocations 时，运营原文里明确写出的「景点 + 城市」
 * 仍是当前路线证据。只读 originalOvernightRoute，不读生成标题、酒店或旧绑定。
 */
function hasExplicitOriginalRouteLocation(product: Json, day: Json, spot: Json): boolean {
  const route = originalOvernightRoute(product, day);
  if (!route) return false;
  const path = orderedItineraryRoutePath(route).replace(/\s+/gu, "");
  const name = textValue(spot.name).replace(/\s+/gu, "");
  const city = toPlatformShortLocationName(spot.city).replace(/\s+/gu, "");
  if (!path || !name || !city) return false;
  const parts = path.split(/[-—–→+＋>＞，,、/／（(【:：&＆]+/u).filter(Boolean);
  const index = parts.indexOf(name);
  return index >= 0 && parts.lastIndexOf(name) === index
    && (parts[index - 1] === city || parts[index + 1] === city);
}

function textValue(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }

/** Overnight inference is anchored at the original route's final administrative stop. */
export function verifiedRouteOvernightCity(product: Json, day: Json): string | undefined {
  const source = originalOvernightRoute(product, day);
  if (!source) return undefined;
  const nodes = currentRouteLocations(product, day).sort((a, b) => a.position - b.position);
  const last = nodes.at(-1);
  if (!last) return undefined;
  const tail = source.slice(last.position + last.name.length).trim();
  if (!/^(?:市|县|旗)?(?:[\s。；;，,]|(?:入住|住宿|当地|酒店|休息))*$/u.test(tail)) return undefined;
  return last.district || last.city;
}
