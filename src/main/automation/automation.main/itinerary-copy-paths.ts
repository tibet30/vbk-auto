/**
 * 行程可见文案的路径模型：平台把「第 N 天行程描述」拆成若干自由文案字段
 * （天标题 / 天描述 / 景点描述 / 其他与自由活动标题与详情 / 餐食描述），
 * 这些字段是 AI 可改写的对象；景点名称、poiName、景点顺序、酒店与餐食
 * 卡片结构都不是文案，禁止在本模型里出现。
 *
 * 这里只做「定位 + 读写」，不含任何 AI 调用与平台请求，便于被
 * itinerary-sensitive-rewrite（草稿保存恢复）与 itinerary-review-copy-repair
 * （审核校验驳回恢复）共用。
 */

export type ItineraryCopyPath =
  | `/itinerary/${number}/title`
  | `/itinerary/${number}/description`
  | `/itinerary/${number}/spots/${number}/description`
  | `/itinerary/${number}/activities/${number}/title`
  | `/itinerary/${number}/activities/${number}/detail`
  | `/itinerary/${number}/mealDescriptions/${number}`;

export interface ParsedItineraryCopyPath {
  dayIndex: number;
  container: "day" | "spots" | "activities" | "mealDescriptions";
  key: "title" | "description" | "detail";
  index?: number;
}

export type ItineraryCopyProduct = { itinerary?: any[] } & Record<string, any>;

const DAY_PATH = /^\/itinerary\/(\d+)\/(title|description)$/;
const NESTED_PATH = /^\/itinerary\/(\d+)\/(spots|activities)\/(\d+)\/(title|description|detail)$/;
const MEAL_PATH = /^\/itinerary\/(\d+)\/mealDescriptions\/(\d+)$/;

function leafAllowed(container: ParsedItineraryCopyPath["container"], key: string, index: number): boolean {
  if (!Number.isInteger(index) || index < 0) return false;
  if (container === "spots") return key === "description";
  if (container === "activities") return key === "title" || key === "detail";
  if (container === "day") return key === "title" || key === "description";
  return true;
}

/** 解析路径；不合法（未知容器 / 景点上写标题 / activities 上写 description）返回 undefined。 */
export function parseItineraryCopyPath(path: unknown): ParsedItineraryCopyPath | undefined {
  if (typeof path !== "string") return undefined;
  const meal = MEAL_PATH.exec(path);
  if (meal) return { dayIndex: Number(meal[1]), container: "mealDescriptions", key: "description", index: Number(meal[2]) };
  const nested = NESTED_PATH.exec(path);
  if (nested) {
    const container = nested[2] as "spots" | "activities";
    if (!leafAllowed(container, nested[4]!, Number(nested[3]))) return undefined;
    return { dayIndex: Number(nested[1]), container, key: nested[4] as ParsedItineraryCopyPath["key"], index: Number(nested[3]) };
  }
  const day = DAY_PATH.exec(path);
  if (day && Number.isInteger(Number(day[1]))) {
    return { dayIndex: Number(day[1]), container: "day", key: day[2] as ParsedItineraryCopyPath["key"] };
  }
  return undefined;
}

/**
 * 只返回命中词的天 / 字段，绝不返回景点名、POI 身份或结构字段。
 * 顺序固定为：天标题、天描述、景点描述、其他活动、餐食描述。
 */
export function findSensitiveItineraryPaths(
  product: ItineraryCopyProduct | undefined,
  sensitiveWords: readonly string[],
): ItineraryCopyPath[] {
  const itinerary = product?.itinerary;
  if (!Array.isArray(itinerary)) return [];
  const words = sensitiveWords.map((word) => String(word ?? "").trim()).filter(Boolean);
  if (!words.length) return [];
  const hit = (value: unknown) => typeof value === "string" && words.some((word) => value.includes(word));

  const paths: ItineraryCopyPath[] = [];
  itinerary.forEach((day: Record<string, any> | undefined, dayIndex: number) => {
    if (hit(day?.title)) paths.push(`/itinerary/${dayIndex}/title`);
    if (hit(day?.description)) paths.push(`/itinerary/${dayIndex}/description`);
    (Array.isArray(day?.spots) ? day!.spots : []).forEach((spot: Record<string, any> | undefined, spotIndex: number) => {
      if (hit(spot?.description)) paths.push(`/itinerary/${dayIndex}/spots/${spotIndex}/description`);
    });
    (Array.isArray(day?.activities) ? day!.activities : []).forEach((activity: Record<string, any> | undefined, activityIndex: number) => {
      if (hit(activity?.title)) paths.push(`/itinerary/${dayIndex}/activities/${activityIndex}/title`);
      if (hit(activity?.detail)) paths.push(`/itinerary/${dayIndex}/activities/${activityIndex}/detail`);
    });
    (Array.isArray(day?.mealDescriptions) ? day!.mealDescriptions : []).forEach((meal: unknown, mealIndex: number) => {
      if (hit(meal)) paths.push(`/itinerary/${dayIndex}/mealDescriptions/${mealIndex}`);
    });
  });
  return paths;
}

export function readItineraryCopy(product: ItineraryCopyProduct | undefined, path: string): unknown {
  const parsed = parseItineraryCopyPath(path);
  if (!parsed) return undefined;
  const day = product?.itinerary?.[parsed.dayIndex];
  if (!day) return undefined;
  if (parsed.container === "day") return day[parsed.key];
  if (parsed.container === "spots") return day.spots?.[parsed.index!]?.description;
  if (parsed.container === "activities") return day.activities?.[parsed.index!]?.[parsed.key];
  return day.mealDescriptions?.[parsed.index!];
}

/** 写入命中字段；目标不存在时抛错，绝不隐式新增天 / 活动 / 餐食。 */
export function writeItineraryCopy(product: ItineraryCopyProduct, path: string, value: string): void {
  const parsed = parseItineraryCopyPath(path);
  if (!parsed) throw new Error(`AI 重写目标不是允许的行程文案路径：${path}`);
  const day = product?.itinerary?.[parsed.dayIndex];
  if (!day) throw new Error(`AI 重写目标不存在：${path}`);
  if (parsed.container === "day") {
    day[parsed.key] = value;
    return;
  }
  if (parsed.container === "spots") {
    const spot = day.spots?.[parsed.index!];
    if (!spot) throw new Error(`AI 重写目标不存在：${path}`);
    spot.description = value;
    return;
  }
  if (parsed.container === "activities") {
    const activity = day.activities?.[parsed.index!];
    if (!activity) throw new Error(`AI 重写目标不存在：${path}`);
    activity[parsed.key] = value;
    return;
  }
  if (!Array.isArray(day.mealDescriptions) || day.mealDescriptions[parsed.index!] === undefined) {
    throw new Error(`AI 重写目标不存在：${path}`);
  }
  day.mealDescriptions[parsed.index!] = value;
}
