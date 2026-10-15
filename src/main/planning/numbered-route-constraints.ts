import type { ProductDetail } from "../../shared/contracts.js";
import { hasCompletePoi, requiresItineraryPoi } from "../../shared/itinerary-activity-kind.js";
import { dayHasTransportArrangement } from "../../shared/itinerary-support-arrangements.js";
import { isAdministrativeLocationName } from "../../shared/location-short-name.js";
import { samePoiName } from "../../shared/poi-name-key.js";
import { hasVerifiedRouteAdministrativeNode } from "../../shared/route-administrative-nodes.js";
import { trustedOperatorItineraryRemovals } from "../../shared/trusted-operator-itinerary-removals.js";

type JsonObject = Record<string, unknown>;

/**
 * 连字符编号的完整路线同样是用户约束；核对途经地，不把行政节点变成 POI。
 *
 * 与运营删除凭证的关系（真实回归：运营在「每日行程」删掉路线景点后仍被要求处理）：
 *   - 运营删除会同时清理当天 title / description 里的景点名，因此不能用
 *     「原文锚点是否还出现在文案里」判定该点仍需处理；删除凭证优先。
 *
 * 与 VBK 官方 POI 名的关系：
 *   - 首选写法是 `spots[].name` 保留路线原文、官方名写进 `poiName`（`words`
 *     同时包含两者，锚点仍然满足），不需要任何额外放行条件；
 *   - 已核验的官方名也允许直接覆盖路线简称（五丈原 → 五丈原诸葛亮庙），但必须
 *     同时满足：路线行政核验已执行过、锚点不在核验出的行政节点里、名称与官方
 *     poiName 互相锚定。缺核验记录时 fail closed，因为无法排除「佛坪」这类
 *     无行政尾缀的裸途经短名被扩成景区。
 */
export function numberedRouteConstraintError(product: ProductDetail, itinerary: Record<string, unknown>[]): string | undefined {
  const basic = product.product.basicInfo as Record<string, unknown> | undefined;
  const raw = String(basic?.userIdea ?? "");
  const days = Number(basic?.days);
  const rows = completeNumberedRouteRows(raw, days);
  if (!rows) return undefined;
  const removals = trustedOperatorItineraryRemovals(product.product);
  for (const row of rows) {
    const dayNumber = Number(row[1]);
    if (dayNumber < 1 || dayNumber > days) return undefined;
    const day = itinerary.find(day => Number(day.day) === dayNumber);
    if (!day) continue; // 天数完整性由主合同统一校验。
    const descriptions = (value: unknown, fields: string[]) => (Array.isArray(value) ? value : [])
      .flatMap(item => item && typeof item === "object" ? fields.map(field => item[field]) : []);
    const words = [day.title, day.description, day.hotel, day.hotelDescription, day.meals,
      ...descriptions(day.spots, ["name", "poiName", "description"]),
      ...descriptions(day.activities, ["title", "detail"])]
      .filter((value): value is string => typeof value === "string").join(" ").replace(/\s+/g, "").replace(/(?:县|市)(?=美食)/gu, "");
    const segments = row[2]!.split(/[-—–→]+/u);
    const allowed = segments.map(segment => cleanAnchor(segment));
    const daySpots = (Array.isArray(day.spots) ? day.spots : []).filter(isRecord);
    const removedToday = (anchor: string) => removals
      .some(receipt => receipt.day === dayNumber && samePoiName(receipt.name, anchor));
    const officialAlias = (anchor: string, spot: JsonObject) => verifiedOfficialAlias(product, dayNumber, anchor, spot);
    const extra = daySpots.find(spot => {
      if (!requiresItineraryPoi(spot)) return false;
      const name = compact(String(spot.name ?? ""));
      if (!name) return false;
      if (allowed.some(anchor => anchor && (anchor === name || anchor.includes(name) || name.endsWith(anchor)))) return false;
      return !allowed.some(anchor => anchor && officialAlias(anchor, spot));
    });
    if (extra) return `第 ${dayNumber} 天用户已给出完整编号路线，不能新增或替换景点「${extra.name}」；请按原始安排保留接送、住宿、自由活动，不把途经城市扩展成景区。`;
    for (const segment of segments) {
      const name = segment.replace(/[;；。]+$/u, "").trim();
      const transfer = name.match(/^(.*?)(?:接|送)(?:飞机|高铁|火车|站|机|团|$)/u);
      const anchor = (transfer ? transfer[1] : name)
        ?.replace(/^(?:住宿|入住|住|游览|参观|前往|泡)/u, "").replace(/住宿$/u, "").trim();
      const normalized = anchor ? compact(anchor) : "";
      if (normalized && !removedToday(normalized) && !words.includes(normalized)
        && !daySpots.some(spot => officialAlias(normalized, spot))) {
        return `第 ${dayNumber} 天未保留用户编号路线中的「${anchor}」，不能继续录入。`;
      }
      if (transfer && !dayHasTransportArrangement(day)) return `第 ${dayNumber} 天未保留用户要求的接送安排。`;
    }
  }
  return undefined;
}

export function hasCompleteNumberedRoute(raw: string, days: number): boolean {
  return Boolean(completeNumberedRouteRows(raw, days));
}

/** 已核验的官方 POI 名覆盖路线简称；行政锚点、自造标签与缺核验记录一律不放行。 */
function verifiedOfficialAlias(product: ProductDetail, day: number, anchor: string, spot: JsonObject): boolean {
  if (!hasCompletePoi(spot) || isAdministrativeAnchor(product, day, anchor)) return false;
  // 缺少路线行政核验记录时 fail closed：没有核验就无法排除「佛坪」这类无行政
  // 尾缀的裸途经短名被扩成景区；此时只能按路线原文名写入 spots。
  if (!hasAdministrativeRouteReadback(product)) return false;
  const name = compact(String(spot.name ?? ""));
  const official = compact(String(spot.poiName ?? ""));
  // 自造标签（名称与官方 poiName 互不包含）不是官方别名，例如
  // name=佛坪秦岭人与自然博物馆 而 poiName=佛坪熊猫谷。
  if (!name || !(samePoiName(name, official) || name.includes(official) || official.includes(name))) return false;
  return official === anchor || official.includes(anchor) || anchor.includes(official)
    || containsAllCharacters(official, anchor);
}

/** 路线行政核验是否实际执行过：字段存在（含空数组）才算有记录。 */
function hasAdministrativeRouteReadback(product: ProductDetail): boolean {
  return Array.isArray(recordValue(product.product.diagnostics)?.routeAdministrativeNodes);
}

/** 行政途经点（含已核验行政节点与产品自身城市字段）不能靠别名扩成景区。 */
function isAdministrativeAnchor(product: ProductDetail, day: number, anchor: string): boolean {
  if (isAdministrativeLocationName(anchor)) return true;
  if (hasVerifiedRouteAdministrativeNode(product.product, anchor, day)) return true;
  const basic = recordValue(product.product.basicInfo);
  const operations = recordValue(product.product.operations);
  const trafficLine = recordValue(operations?.trafficLine);
  return [basic?.meetingCity, basic?.destinationCity, basic?.destination,
    operations?.pickupCity, trafficLine?.arrivalCity, trafficLine?.departureCity]
    .some(value => samePoiName(value, anchor));
}

/** 「城固张骞故里」→「张骞故里城固」这类同字集重排仍指同一路线点。 */
function containsAllCharacters(haystack: string, needle: string): boolean {
  return [...new Set(needle)].every(character => haystack.includes(character));
}

function completeNumberedRouteRows(raw: string, days: number): RegExpMatchArray[] | undefined {
  const route = raw.replace(/(?:^|[\n\r])\s*(?:住宿与商业配置|住宿配置|商业配置|录入配置)[:：][\s\S]*$/u, "");
  const rows = [...route.matchAll(/^\s*(\d{1,2})\s*[-、:：.]\s*([^\n\r]+)/gm)];
  if (rows.length !== days || new Set(rows.map(row => Number(row[1]))).size !== days
    || rows.some(row => Number(row[1]) < 1 || Number(row[1]) > days)
    || !rows.some(row => /---|→|—/u.test(row[2]!))) return undefined;
  return rows;
}
function cleanAnchor(segment: string): string {
  return compact(segment.replace(/[;；。]+$/u, "").trim().replace(/^(?:住宿|入住|住|游览|参观|前往|泡)/u, "").replace(/住宿$/u, ""));
}
function compact(value: string): string { return value.replace(/\s+/gu, "").replace(/(?:县|市)(?=美食)/gu, ""); }
function isRecord(value: unknown): value is JsonObject { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function recordValue(value: unknown): JsonObject | undefined { return isRecord(value) ? value : undefined; }
