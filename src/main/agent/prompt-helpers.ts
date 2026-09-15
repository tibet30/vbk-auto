import { inferHotelTierFromUserText } from "../../shared/hotel-tiers.js";
import type { DailyTransport } from "../../shared/product-form.js";
import { toPlatformShortLocationName } from "../../shared/location-short-name.js";
import type { ProductDetail } from "../../shared/contracts.js";
import type { LockedConstraints, LockedItineraryDay } from "../../shared/contracts-preparation.js";
import { parseProductBriefMessage } from "../../shared/product-brief-message.js";
import { isPendingApprovalStatusFollowup, preservesApprovedIntent } from "./approval-intent.js";

const DAY_TOKEN: Record<string, number> = {
  "1": 1, "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 7, "8": 8, "9": 9, "10": 10,
  一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
};

export function isPlanningControlMessage(content: string): boolean {
  const text = content.trim();
  if (!text) return true;
  if (parseProductBriefMessage(text)) return true;
  if (preservesApprovedIntent(text) || isPendingApprovalStatusFollowup(text)) return true;
  const compact = text.replace(/\s+/g, "").replace(/[。！!？?]+$/g, "");
  if (/^请读取刚创建的产品和用户要求/.test(compact) && /VBK写入.*审批/.test(compact)) return true;
  if (/^(?:确认|批准|同意)(?:录入|吧|了)?$|^(?:可以录入|开始录入|录入吧|请录入|最终确认)$/.test(compact)) return true;
  return /(?:当前|现在)?(?:进度|状态)|做到哪了|怎么样了/.test(compact)
    && !/(?:改|修改|调整|变更|景点|行程|价格|酒店|套餐|POI)/i.test(compact);
}

export function filterPlanningRequirementMessages<T extends { role: string; content: string }>(messages: T[]): T[] {
  return messages.filter((message) => message.role === "user" && !isPlanningControlMessage(message.content));
}

export function extractLockedConstraints(
  product: ProductDetail,
  messages: Array<{ role: string; content: string }> = [],
): LockedConstraints {
  const data = product.product as Record<string, unknown>;
  const basic = asObject(data.basicInfo);
  const operations = asObject(data.operations);
  const sales = asObject(data.sales);
  const traffic = asObject(operations?.trafficLine);
  const initialRequirement = text(basic?.userIdea);
  const laterRequirements = filterPlanningRequirementMessages(messages).map((message) => message.content);
  const requirementText = [initialRequirement, ...laterRequirements].filter(Boolean).join("\n");
  const fromIntent = intentConstraints(product);
  const itineraryConstraints = resolveItineraryConstraints(initialRequirement, laterRequirements, fromIntent);
  const transport = latestParsedValue([initialRequirement, ...laterRequirements], transportFromText);
  const hotelTier = latestParsedValue([initialRequirement, ...laterRequirements], inferHotelTierFromUserText);
  const days = Number(basic?.days);
  const arrivalCity = text(traffic?.arrivalCity);
  const departureCity = text(traffic?.departureCity);
  return {
    ...(text(basic?.destinationCity || basic?.meetingCity) ? { destinationCity: toPlatformShortLocationName(text(basic?.destinationCity || basic?.meetingCity)) } : {}),
    ...(text(basic?.meetingCity) ? { meetingCity: toPlatformShortLocationName(text(basic?.meetingCity)) } : {}),
    ...(Number.isInteger(days) && days > 0 ? { days } : {}),
    ...(Number.isInteger(Number(basic?.nights)) ? { nights: Number(basic?.nights) } : {}),
    ...(text(sales?.productForm) ? { productForm: text(sales?.productForm) } : {}),
    ...(transport ? { transport } : {}),
    ...(hotelTier ? { hotelTier } : {}),
    ...(arrivalCity && requirementText.includes(arrivalCity) ? { arrivalCity } : {}),
    ...(departureCity && requirementText.includes(departureCity) ? { departureCity } : {}),
    pois: itineraryConstraints.pois,
    itineraryOrder: itineraryConstraints.itineraryOrder,
  };
}

function resolveItineraryConstraints(
  initialRequirement: string,
  laterRequirements: string[],
  fromIntent: { pois: string[]; itineraryOrder: LockedItineraryDay[] },
): { pois: string[]; itineraryOrder: LockedItineraryDay[] } {
  const initial = parseDayConstraints(initialRequirement);
  const itineraryOrder = new Map<number, string[]>();
  const generalPois = new Set<string>();
  const baselineOrder = fromIntent.itineraryOrder.length ? fromIntent.itineraryOrder : initial.itineraryOrder;
  const baselinePois = fromIntent.pois.length
    ? fromIntent.pois
    : unique([...initial.pois, ...parseMustPois(initialRequirement)]);
  for (const row of baselineOrder) itineraryOrder.set(row.day, [...row.spots]);
  const daySpecificPois = baselineOrder.flatMap((row) => row.spots);
  for (const poi of baselinePois) {
    if (!daySpecificPois.some((spot) => sameConstraintPlace(spot, poi))) generalPois.add(poi);
  }

  for (const requirement of laterRequirements) {
    const parsed = parseDayConstraints(requirement);
    const removed = parseRemovedPois(requirement);
    for (const poi of removed) {
      generalPois.delete(poi);
      for (const [day, spots] of itineraryOrder) {
        itineraryOrder.set(day, spots.filter((spot) => !sameConstraintPlace(spot, poi)));
      }
    }
    const correction = isItineraryCorrection(requirement);
    for (const row of parsed.itineraryOrder) {
      const existing = itineraryOrder.get(row.day) ?? [];
      if (correction) for (const poi of existing) generalPois.delete(poi);
      itineraryOrder.set(row.day, correction ? [...row.spots] : unique([...existing, ...row.spots]));
    }
    const parsedDayPois = parsed.itineraryOrder.flatMap((row) => row.spots);
    for (const poi of [...parseMustPois(requirement), ...parseReplacementPois(requirement)]) {
      if (parsedDayPois.some((spot) => sameConstraintPlace(spot, poi))) continue;
      generalPois.add(poi);
    }
  }

  const order = [...itineraryOrder.entries()]
    .filter(([, spots]) => spots.length > 0)
    .sort(([left], [right]) => left - right)
    .map(([day, spots]) => ({ day, spots: unique(spots) }));
  return {
    pois: unique([...generalPois, ...order.flatMap((row) => row.spots)]),
    itineraryOrder: order,
  };
}

function parseDayConstraints(textValue: string): { pois: string[]; itineraryOrder: LockedItineraryDay[] } {
  const itineraryOrder: LockedItineraryDay[] = [];
  const pois: string[] = [];
  const marker = /(?:D|d|第)\s*([0-9一二三四五六七八九十]+)\s*天?/g;
  const matches = [...textValue.matchAll(marker)];
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index]!;
    const day = DAY_TOKEN[match[1] ?? ""] ?? Number(match[1]);
    const start = (match.index ?? 0) + match[0].length;
    const end = matches[index + 1]?.index ?? textValue.length;
    const remainder = trimPlanningControlTail(textValue.slice(start, end)).replace(/^[:：、，,\s]+/, "").trim();
    if (!Number.isInteger(day) || day < 1 || /^(?:不要|不安排|别)/.test(remainder)) continue;
    const spots = splitSpots(remainder);
    if (!spots.length) continue;
    const existing = itineraryOrder.find((row) => row.day === day);
    if (existing) existing.spots = unique([...existing.spots, ...spots]);
    else itineraryOrder.push({ day, spots });
    pois.push(...spots);
  }
  return { pois, itineraryOrder };
}

function parseMustPois(textValue: string): string[] {
  const pois: string[] = [];
  const marker = /(?:必须|一定要|指定)(?:去|游览|参观|安排)?\s*([^，。,\n]{2,20})/g;
  for (const match of textValue.matchAll(marker)) {
    pois.push(...splitSpots(match[1] ?? ""));
  }
  return pois;
}

function parseRemovedPois(textValue: string): string[] {
  const pois: string[] = [];
  const marker = /(?:不要去|不去|取消|去掉|删除|不安排)\s*([^，。,:：\n]{2,20})/g;
  for (const match of textValue.matchAll(marker)) pois.push(...splitSpots(match[1] ?? ""));
  return unique(pois);
}

function parseReplacementPois(textValue: string): string[] {
  const pois: string[] = [];
  const marker = /(?:改成|改为|换成|改去|换去|替换为)\s*([^，。,:：\n]{2,20})/g;
  for (const match of textValue.matchAll(marker)) pois.push(...splitSpots(match[1] ?? ""));
  return unique(pois);
}

function isItineraryCorrection(value: string): boolean {
  return /(?:改成|改为|换成|调整为|替换为|重新安排|改去|换去|取消|去掉|删除|不要去|不去)/.test(value);
}

function splitSpots(value: string): string[] {
  return value
    .replace(/【[^】]*】|\[[^\]]*\]|\([^)]*\)|（[^）]*）/gu, " ")
    .replace(/包车|专车|拼车|当地[345四五三]钻.*$|钻酒店.*$/g, " ")
    .replace(/(?:火车站接|接火车站|送火车|送站|住[^—–\-，,、。；;\n]{2,})/gu, " ")
    .replace(/(?:二选一|多选一|任选其一)/gu, " ")
    .replace(/(?:或者|或|\/|／)/gu, "，")
    .replace(/[—–-]+/gu, "，")
    .split(/[和与、，,以及]+/)
    .map((item) => item.replace(/^(?:(?:必须)?(?:去|游览|安排|参观)|再?(?:改成|改为|换成|调整为|替换为|改去|换去)|再加|增加|加上)/, "").trim())
    .filter(looksLikePlaceName);
}

/**
 * A product brief can append execution preferences after the last daily route.
 * They are not itinerary constraints, even when the last route is introduced
 * by a D1/D2 marker. Keeping them here would turn "AI 自我修复" into a POI.
 */
function trimPlanningControlTail(value: string): string {
  return value.replace(
    /(?:[\n。；;]\s*)+(?:端到端.*(?:测试|验证|复验)|本次已授权|重新创建新产品|修复共享问题|资料准备|期望在资料准备|如需处理|无需(?:再)?询问用户|不需要(?:再)?询问用户|请读取刚创建的产品|任何\s*VBK\s*写入)[\s\S]*$/u,
    "",
  );
}

function looksLikePlaceName(item: string): boolean {
  if (item.length < 2 || item.length > 20) return false;
  if (/[{}"']/.test(item) || /destination|productForm|userIdea|nights/.test(item)) return false;
  if (/不要|不安排|不需要|可以|希望|期望|资料|准备|询问|审批|明确|端到端|测试|轻松|适合|带孩子|建议|最好|左右|一下|安排点/.test(item)) return false;
  if (/[的了吗呢吧]/.test(item) && item.length > 6) return false;
  return true;
}

function transportFromText(value: string): DailyTransport | undefined {
  const correction = value.match(/(?:改成|改为|换成|调整为)\s*(包车|专车|拼车)/);
  if (correction?.[1]) return correction[1] === "拼车" ? "shared" : "charter";
  if (/必须(?:包车|专车)|要包车|包车出行|包车，|，包车|专车出行/.test(value) || /(?:^|[\n，,])包车(?:[，,]|$)/.test(value)) return "charter";
  if (/包车|专车/.test(value) && /D\s*\d|第\s*[0-9一二三四五六七八九十]+\s*天/.test(value)) return "charter";
  if (/拼车/.test(value) && /D\s*\d|第\s*[0-9一二三四五六七八九十]+\s*天|必须/.test(value)) return "shared";
  return undefined;
}

function latestParsedValue<T>(values: string[], parse: (value: string) => T | undefined): T | undefined {
  let result: T | undefined;
  for (const value of values) {
    const parsed = parse(value);
    if (parsed !== undefined) result = parsed;
  }
  return result;
}

function sameConstraintPlace(left: string, right: string): boolean {
  const normalise = (value: string) => value.replace(/\s+/g, "");
  return normalise(left) === normalise(right);
}

function intentConstraints(product: ProductDetail): { pois: string[]; itineraryOrder: LockedItineraryDay[] } {
  const intent = product.planning?.userIntent;
  if (!intent) return { pois: [], itineraryOrder: [] };
  const order = new Map<number, string[]>();
  const pois: string[] = [];
  for (const activity of intent.activities ?? []) {
    if (activity.kind !== "poi") continue;
    const names = [activity.title, ...(activity.alternatives ?? [])].map((item) => item.trim()).filter(Boolean);
    pois.push(...names);
    if (activity.day > 0 && names[0]) {
      const spots = order.get(activity.day) ?? [];
      spots.push(names[0]);
      order.set(activity.day, spots);
    }
  }
  return {
    pois,
    itineraryOrder: [...order.entries()].sort((left, right) => left[0] - right[0]).map(([day, spots]) => ({ day, spots })),
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((item) => item.trim()).filter(Boolean))];
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
