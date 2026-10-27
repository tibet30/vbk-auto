/**
 * 路线走廊几何：判断一个坐标是否落在当日已核验路线附近。
 *
 * 路线锚点只到行政城市级。单侧锚点、或相邻锚点分属不同城市时，景点完全可能
 * 落在第三个城市（羊卓雍错在山南，夹在拉萨与日喀则之间；公珠错在阿里，位于
 * 萨嘎之后）。仅凭「同省 + 原文点名 + 本次搜索结果唯一」不能证明地点：正确
 * 的那条不在结果里时，会把同名异城 POI 绑上去。走廊用平台返回的坐标给出正面
 * 证据，坐标随 POI 绑定持久化在 spot 上，回读时可离线重算。
 */

/**
 * 走廊半径（公里）。实测：拉萨、吉林长线中正确的跨地州景点离走廊 3.9～55.3 km；
 * 同省同名异城（如日喀则与林芝）相距数百公里。
 */
export const ROUTE_CORRIDOR_RADIUS_KM = 80;

export interface GeoPoint { lat: number; lng: number }

export function geoPoint(value: { latitude?: unknown; longitude?: unknown } | undefined): GeoPoint | undefined {
  const lat = Number(value?.latitude);
  const lng = Number(value?.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return undefined;
  // 平台缺坐标时偶见 0/0，按缺失处理。
  return lat === 0 && lng === 0 ? undefined : { lat, lng };
}

/** 点到参考点折线（按行程顺序）的最短距离；没有参考点时返回 undefined。 */
export function corridorDistanceKm(point: GeoPoint, references: readonly GeoPoint[]): number | undefined {
  if (!references.length) return undefined;
  if (references.length === 1) return haversineKm(point, references[0]!);
  let best = Infinity;
  for (let index = 1; index < references.length; index += 1) {
    best = Math.min(best, segmentDistanceKm(point, references[index - 1]!, references[index]!));
  }
  return best;
}

const EARTH_RADIUS_KM = 6371;
const RADIANS = Math.PI / 180;

function haversineKm(a: GeoPoint, b: GeoPoint): number {
  const dLat = (b.lat - a.lat) * RADIANS;
  const dLng = (b.lng - a.lng) * RADIANS;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * RADIANS) * Math.cos(b.lat * RADIANS) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** 局部等距投影下的点到线段距离；走廊尺度（数百公里）内误差可忽略。 */
function segmentDistanceKm(point: GeoPoint, start: GeoPoint, end: GeoPoint): number {
  const latitude = ((start.lat + end.lat + point.lat) / 3) * RADIANS;
  const project = (value: GeoPoint) => ({
    x: value.lng * RADIANS * Math.cos(latitude) * EARTH_RADIUS_KM, y: value.lat * RADIANS * EARTH_RADIUS_KM,
  });
  const p = project(point), a = project(start), b = project(end);
  const dx = b.x - a.x, dy = b.y - a.y;
  const length = dx * dx + dy * dy;
  const t = length === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}
