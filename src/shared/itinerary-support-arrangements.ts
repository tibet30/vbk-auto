import { hasCompletePoi } from "./itinerary-activity-kind.js";

type Json = Record<string, unknown>;
export type SupportingArrangement = { time: string; title: string; detail: string; type: "transport" | "meal" | "hotel" };

/** 服务地点和后勤安排不是游览站点。真实核验过的旅游 POI 不凭名称降级。 */
export function supportArrangementType(value: unknown, day?: unknown): SupportingArrangement["type"] | undefined {
  const spot = record(value);
  if (hasCompletePoi(spot)) return undefined;
  const name = text(spot.name) || text(spot.title);
  if (/^(?:早餐|午餐|晚餐|正餐|用餐|餐食)/u.test(name)) return "meal";
  if (/(?:接团|送团|接机|送机|接站|送站|送高铁|送飞机|接送|集合|解散|返程)/u.test(name)
    || /(?:接|送)$/u.test(name) || /(?:酒店|宾馆|民宿|客栈).*(?:出发|退房|离开)/u.test(name)
    || /(?:机场|航站楼|火车站|高铁站|动车站|汽车站|客运站|码头|站)$/u.test(name)) return "transport";
  if (/(?:酒店|宾馆|民宿|客栈|办理入住|住宿)$/u.test(name)) return "hotel";
  if (spot.kind === "other" && day) {
    const row = record(day);
    const detail = text(spot.description) || text(row.description);
    const anchor = text(record(row.hotelRequirement).anchorName).replace(/(?:市|县|镇|村)$/u, "");
    if (/(?:镇|村|城区|市区|广场)$/u.test(name) && anchor && name.includes(anchor)) return "hotel";
    // 只把已有明确出发/入住用途的地点移出，未匹配 POI 的游览地点仍保留。
    const locality = name.replace(/^.*?(?:县|区)/u, "");
    const place = locality.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (place && (new RegExp(`(?:离开|由|从).{0,8}${place}`, "u").test(detail)
      || new RegExp(`(?:送至|前往).{0,8}${place}.{0,12}(?:入住|办理入住)`, "u").test(detail))) return "transport";
    if (/美食$/u.test(name)) return "meal";
  }
  return undefined;
}

export function itinerarySupportingArrangements(day: unknown): SupportingArrangement[] {
  const row = record(day);
  const result: SupportingArrangement[] = [];
  for (const activity of Array.isArray(row.activities) ? row.activities : []) {
    const item = record(activity);
    const type = ["transport", "meal", "hotel"].includes(text(item.type))
      ? item.type as SupportingArrangement["type"] : supportArrangementType(item, row);
    if (type && text(item.title)) result.push({ time: text(item.time) || "不限", title: text(item.title), detail: text(item.detail) || text(item.title), type });
  }
  const serviceSpots = (Array.isArray(row.spots) ? row.spots : []).filter((spot) => supportArrangementType(spot, row));
  const transfer = serviceSpots.filter((spot) => supportArrangementType(spot, row) !== "meal");
  if (transfer.some((spot) => supportArrangementType(spot, row) === "transport") && !result.some((item) => item.type === "transport")) {
    result.push({ time: "不限", title: text(row.title) || "接送与出发安排",
      detail: text(row.description) || transfer.map((spot) => text(record(spot).name)).join("；"), type: "transport" });
  }
  const meals = text(row.meals) || serviceSpots.filter((spot) => supportArrangementType(spot, row) === "meal")
    .map((spot) => text(record(spot).description) || text(record(spot).name)).join("；");
  if (meals && !result.some((item) => item.type === "meal")) result.push({ time: "不限", title: "餐食说明", detail: meals, type: "meal" });
  const lodging = serviceSpots.filter((spot) => supportArrangementType(spot, row) === "hotel")
    .map((spot) => text(record(spot).name)).join("；");
  if (!text(row.hotel) && lodging && !result.some((item) => item.type === "hotel")) {
    result.push({ time: "不限", title: "住宿安排", detail: lodging, type: "hotel" });
  }
  return result;
}

/** Persist service arrangements outside spots; repeated generation cannot recreate service stations. */
export function normaliseItinerarySupport<T extends object>(day: T): T {
  const row = day as Json;
  const arrangements = itinerarySupportingArrangements(day);
  const spots = (Array.isArray(row.spots) ? row.spots : []).filter((spot) => !supportArrangementType(spot, row));
  const activities = (Array.isArray(row.activities) ? row.activities : []).filter((activity) => {
    const item = record(activity);
    return !["transport", "meal", "hotel"].includes(text(item.type)) && !supportArrangementType(item, row);
  });
  // Meals and overnight lodging have canonical fields, so they must not be duplicated as activities.
  const transports = arrangements.filter((item) => item.type === "transport");
  const meal = arrangements.filter((item) => item.type === "meal").map((item) => item.detail).join("；");
  const lodging = arrangements.filter((item) => item.type === "hotel").map((item) => item.detail).join("；");
  return { ...day, spots, ...(!text(row.meals) && meal ? { meals: meal } : {}),
    ...(!text(row.hotel) && lodging ? { hotel: lodging } : {}),
    ...(activities.length || transports.length ? { activities: [...activities, ...transports] }
    : Array.isArray(row.activities) ? { activities: [] } : {}) };
}

export function dayHasTransportArrangement(day: unknown): boolean {
  return itinerarySupportingArrangements(day).some((item) => item.type === "transport" && Boolean(item.detail));
}

function record(value: unknown): Json { return value && typeof value === "object" && !Array.isArray(value) ? value as Json : {}; }
function text(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
