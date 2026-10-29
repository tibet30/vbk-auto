import type { ProductDetail } from "../../shared/contracts.js";
import { isReplayDataMissing } from "../infrastructure/replay-data-error.js";
import { isPersistedRouteTravelNode } from "../../shared/itinerary-route-travel-node.js";
import { effectiveItinerarySpotKind } from "../../shared/itinerary-activity-kind.js";
import { itinerarySupportingArrangements, supportArrangementType } from "../../shared/itinerary-support-arrangements.js";
import { parseProductBriefMessage } from "../../shared/product-brief-message.js";
import { constraintUserIdea } from "../../shared/product-idea-optimization.js";
import { daySection } from "./day-sections.js";
import {
  ITINERARY_DAY_TITLE_MAX_LENGTH,
  itineraryDayTitleBudget,
  itineraryDayTitleLength,
  itineraryDayTitleProblem,
} from "../../shared/itinerary-day-title.js";
import {
  PRIVATE_TOUR_DAY_TITLE_PREFIXES,
  PRIVATE_TOUR_DEFAULT_PREFIX,
  PRIVATE_TOUR_FREE_PREFIX,
  fitPrivateTourDayTitle,
  isPrivateTourProduct,
  privateTourDayTitleNodes,
  privateTourDayTitleProblem,
  type PrivateTourTitleFacts,
} from "../../shared/private-tour-day-title.js";

type JsonObject = Record<string, unknown>;

export interface ItineraryDayTitleRequest {
  day: number;
  /** 本天标题（不含首日前缀）可用字符数。 */
  maxLength: number;
  /** 私家团标题须为「前缀｜当天内容」并受 24 字整行上限约束。 */
  format?: "privateTour";
  /** 标题必须原样包含的景点名。 */
  requiredNames: string[];
  /** 私家团可选景点：放得下才写，最多凑满 3 个。 */
  optionalNames?: string[];
  /** 原路线中须以独立节点保留的途经地。 */
  routeNodes: string[];
  /** 当前确定性标题，同时也是 AI 失败时的兜底。 */
  currentTitle: string;
  /** 用户原始逐日安排，只作为事实来源。 */
  sourceText: string;
  hotel: string;
  /** 上一轮被拒原因；首轮为空。 */
  rejectedReason?: string;
}

export type ItineraryDayTitleGenerator = (requests: ItineraryDayTitleRequest[]) => Promise<Array<{ day: number; title: string }>>;

/**
 * 确定性兜底标题：不在字符中间截断。景点串放得下就整串保留；放不下时只保留
 * 能完整放下的前几个景点并注明总数；无景点日取路线首行，仍放不下则用通用标题。
 */
export function fallbackDayTitle(args: { day: number; title: string; names: string[]; budget: number; routeNodes?: string[] }): string {
  const { day, title, names, budget, routeNodes = [] } = args;
  if (!itineraryDayTitleProblem(title, budget)) return title.trim();
  if (names.length) {
    const all = names.join(" · ");
    if (itineraryDayTitleLength(all) <= budget) return all;
    for (let count = names.length - 1; count >= 0; count -= 1) {
      const selected = new Set([...names.slice(0, count), ...routeNodes]);
      if (!selected.size) continue;
      const candidate = `${names.filter((name) => selected.has(name)).join(" · ")} · 等${names.length}处景点`;
      if (itineraryDayTitleLength(candidate) <= budget) return candidate;
    }
  }
  if (routeNodes.length) throw new Error(`第 ${day} 天标题无法在长度限制内保留全部途经点`);
  return `第${day}天行程安排`;
}

/**
 * 让 AI 为确定性投影的行程重写天标题。每个标题都要本地校验：长度、单行、
 * 必须包含当天全部景点名、不得出现其他天的景点；不合格的天带原因重试一次，
 * 仍不合格（或 AI 调用失败）就保留确定性兜底标题。
 */
export async function generateItineraryDayTitles(args: {
  product: JsonObject;
  itinerary: JsonObject[];
  sourceText: (day: number) => string;
  generate: ItineraryDayTitleGenerator;
  onWarning?: (message: string) => void;
}): Promise<JsonObject[]> {
  const requests = args.itinerary.map((day) => titleRequest(args.product, day, args.sourceText(Number(day.day))));
  const accepted = new Map<number, string>();
  let pending = requests;
  for (let attempt = 0; attempt < 2 && pending.length; attempt += 1) {
    let generated: Array<{ day: number; title: string }>;
    try {
      generated = await args.generate(pending);
    } catch (error) {
      if (isReplayDataMissing(error)) throw error;
      args.onWarning?.(`AI 生成天标题失败，保留兜底标题：${error instanceof Error ? error.message : String(error)}`);
      pending = [];
      break;
    }
    const byDay = new Map(generated.map((item) => [Number(item.day), typeof item.title === "string" ? item.title.trim() : ""]));
    pending = pending.flatMap((request) => {
      const title = byDay.get(request.day) ?? "";
      const problem = titleProblem(args.product, args.itinerary, request, title);
      if (!problem) {
        accepted.set(request.day, title);
        return [];
      }
      return [{ ...request, rejectedReason: problem }];
    });
  }
  for (const request of pending) {
    args.onWarning?.(`第 ${request.day} 天 AI 标题未通过校验（${request.rejectedReason ?? "未返回"}），保留兜底标题。`);
  }
  return args.itinerary.map((day) => {
    const title = accepted.get(Number(day.day));
    return title ? { ...day, title } : day;
  });
}

/** 写入前最后一道保证：标题仍不合格就替换成兜底标题（不截断）。 */
export function ensureDayTitleFits(product: JsonObject, day: JsonObject): JsonObject {
  const dayNumber = Number(day.day);
  const budget = Math.min(ITINERARY_DAY_TITLE_MAX_LENGTH, itineraryDayTitleBudget(product, dayNumber));
  const title = text(day.title);
  if (isPrivateTourProduct(product)) return ensurePrivateTourDayTitle(product, day, dayNumber, budget);
  if (!itineraryDayTitleProblem(title, budget)) return day;
  const names = [...new Set([...sequenceNames(title), ...spotNames(day)])];
  const routeNodes = names.filter((name) => isPersistedRouteTravelNode(product, day, name));
  return { ...day, title: fallbackDayTitle({ day: dayNumber, title: routeLine(title), names, budget, routeNodes }) };
}

/**
 * 私家团：AI 重试仍不合格时先从末尾删节点；仍不合格就用当天景点与途经节点重组
 * 「前缀｜内容」。结果必须仍含全部必含项（首个景点与途经节点），否则报错不写入。
 */
function ensurePrivateTourDayTitle(product: JsonObject, day: JsonObject, dayNumber: number, budget: number): JsonObject {
  // 首日前缀在保存时统一追加，预算已扣除；这里先去掉，避免重复计数。
  const title = text(day.title).replace(/^(?:【出发地\s*[-－—–]\s*[^】]+】\s*)+/u, "");
  const { names, routeNodes, required, facts } = privateTourDayFacts(product, { ...day, title });
  const spots = spotNames(day);
  const fits = (candidate: string) => !privateTourDayTitleProblem(candidate, budget, facts)
    && required.every((name) => compact(candidate).includes(compact(name)));
  if (title && fits(title)) return title === text(day.title) ? day : { ...day, title };
  const route = routeLine(title);
  const head = route.split("｜")[0]!.trim();
  const hasPrefix = route.includes("｜") && (PRIVATE_TOUR_DAY_TITLE_PREFIXES as readonly string[]).includes(head);
  const prefix = hasPrefix ? head : privateTourFallbackPrefix(day, routeNodes);
  const fitted = fitPrivateTourDayTitle(hasPrefix ? route : `${prefix}｜${route}`, budget, required, facts);
  if (route && fits(fitted)) return { ...day, title: fitted };
  // 原标题是整句或放不下：只用当天事实（景点、途经节点）重组，不写通用占位。
  const ordered = names.filter((name) => spots.includes(name) || routeNodes.includes(name));
  if (ordered.length) {
    const content = ordered.map((name, index) => (!index ? "" : routeNodes.includes(name) || routeNodes.includes(ordered[index - 1]!) ? "-" : "·") + name).join("");
    const rebuilt = fitPrivateTourDayTitle(`${prefix}｜${content}`, budget, required, facts);
    if (fits(rebuilt)) return { ...day, title: rebuilt };
  }
  if (required.length) throw new Error(`第 ${dayNumber} 天标题无法在长度限制内保留全部必含景点与途经点`);
  return { ...day, title: `${prefix}｜第${dayNumber}天行程安排` };
}

/**
 * 兜底前缀：有接送/用车安排的天用专车前缀（接送方向唯一可判定时用接机/接站/送机/送站），
 * 只有真正的自由活动天（free 活动、无交通、无景点无途经点）才用「自由活动」。
 */
function privateTourFallbackPrefix(day: JsonObject, routeNodes: string[]): string {
  const transports = itinerarySupportingArrangements(day).filter((item) => item.type === "transport");
  if (transports.length) return transferPrefix(transports.map((item) => `${item.title} ${item.detail}`).join(" "));
  const spots = Array.isArray(day.spots) ? day.spots.filter((spot): spot is JsonObject => Boolean(spot) && typeof spot === "object") : [];
  const activities = Array.isArray(day.activities) ? day.activities as JsonObject[] : [];
  const free = spots.some((spot) => effectiveItinerarySpotKind(spot) === "free") || activities.some((item) => item?.type === "free");
  const attractions = spots.filter((spot) => effectiveItinerarySpotKind(spot) === "attraction" && !supportArrangementType(spot, day));
  return free && !attractions.length && !routeNodes.length ? PRIVATE_TOUR_FREE_PREFIX : PRIVATE_TOUR_DEFAULT_PREFIX;
}

const TRANSFER_PREFIXES: Array<[string, RegExp]> = [
  ["专车接机", /接机|接飞机|机场接/u], ["专车接站", /接站|接火车|接高铁|火车站接|高铁站接/u],
  ["专车送机", /送机|送飞机|送至?机场/u], ["专车送站", /送站|送火车|送高铁|送至?(?:火车|高铁)站/u],
];

function transferPrefix(source: string): string {
  const matched = TRANSFER_PREFIXES.filter(([, pattern]) => pattern.test(source));
  return matched.length === 1 ? matched[0]![0] : PRIVATE_TOUR_DEFAULT_PREFIX;
}

/** 私家团当天事实：必含项为首个景点（无景点时取首个非接送节点）与途经节点。 */
function privateTourDayFacts(product: JsonObject, day: JsonObject) {
  const title = text(day.title);
  const spots = spotNames(day);
  const names = [...new Set([...sequenceNames(title), ...privateTourDayTitleNodes(routeLine(title), spots), ...spots])];
  const routeNodes = names.filter((name) => isPersistedRouteTravelNode(product, day, name));
  const first = spots[0] ?? names.find((name) => !routeNodes.includes(name) && !supportArrangementType({ name }));
  const required = [...new Set([...(first ? [first] : []), ...routeNodes])];
  const facts: PrivateTourTitleFacts = { allowedNames: [...required, ...routeNodes], spots };
  return { names, routeNodes, required, facts };
}

/** 供生成服务判断规划标题是否需要重写：与写入前校验使用同一组当天事实。 */
export function privateTourDayTitleFacts(product: JsonObject, day: JsonObject): PrivateTourTitleFacts {
  return privateTourDayFacts(product, day).facts;
}

/** 路线首行：去掉括号建议与句末标点，供无景点日的兜底标题使用。 */
export function routeLine(raw: string): string {
  const line = raw.trim().split(/\r?\n/u)[0] ?? "";
  return line.replace(/[（(][^）)]*[）)]/gu, "").replace(/[。；;，,\s]+$/u, "").trim();
}

/** 用户原始逐日安排：投影与 AI 标题共用同一份当日原文。 */
export function itineraryDaySourceText(product: ProductDetail, day: number): string {
  const sources = [constraintUserIdea(product.product.basicInfo), ...(product.messages ?? [])
    .filter((message) => message.role === "user")
    .map((message) => parseProductBriefMessage(message.content)?.userIdea?.trim() || message.content)];
  return sources.map((value) => daySection(value, day).replace(/^[:：、，,\s]+/u, "").trim()).filter(Boolean).at(-1) ?? "";
}

function titleRequest(product: JsonObject, day: JsonObject, sourceText: string): ItineraryDayTitleRequest {
  const dayNumber = Number(day.day);
  if (isPrivateTourProduct(product)) return privateTourTitleRequest(product, day, dayNumber, sourceText);
  return {
    day: dayNumber,
    maxLength: Math.min(ITINERARY_DAY_TITLE_MAX_LENGTH, itineraryDayTitleBudget(product, dayNumber)),
    // 投影标题里的途经节点（「延吉」「日喀则」）不在 spots 里，但下游靠标题识别
    // 途经地，AI 标题同样必须保留。
    requiredNames: [...new Set([...spotNames(day), ...sequenceNames(text(day.title))])],
    routeNodes: sequenceNames(text(day.title)).filter((name) => isPersistedRouteTravelNode(product, day, name)),
    currentTitle: text(day.title),
    sourceText: sourceText.trim(),
    hotel: text(day.hotel),
  };
}

/** 私家团只要求首个景点与途经节点，其余景点按 24 字预算取舍。 */
function privateTourTitleRequest(product: JsonObject, day: JsonObject, dayNumber: number, sourceText: string): ItineraryDayTitleRequest {
  const { routeNodes, required } = privateTourDayFacts(product, day);
  return {
    day: dayNumber,
    format: "privateTour",
    maxLength: itineraryDayTitleBudget(product, dayNumber),
    requiredNames: required,
    optionalNames: spotNames(day).filter((name) => !required.includes(name)),
    routeNodes,
    currentTitle: text(day.title),
    sourceText: sourceText.trim(),
    hotel: text(day.hotel),
  };
}

function titleProblem(product: JsonObject, itinerary: JsonObject[], request: ItineraryDayTitleRequest, title: string): string | undefined {
  const day = itinerary.find((item) => Number(item.day) === request.day) ?? { day: request.day };
  const basic = request.format === "privateTour"
    ? privateTourDayTitleProblem(title, request.maxLength, {
      allowedNames: [...request.requiredNames, ...(request.optionalNames ?? []), ...request.routeNodes], spots: spotNames(day) })
    : itineraryDayTitleProblem(title, request.maxLength);
  if (basic) return basic;
  const compactTitle = compact(title);
  const missing = request.requiredNames.filter((name) => !compactTitle.includes(compact(name)));
  if (missing.length) return `缺少当天景点：${missing.join("、")}`;
  const lostNodes = request.routeNodes.filter((name) => !isPersistedRouteTravelNode(product, { ...day, title }, name));
  if (lostNodes.length) return `途经点须保持独立路线节点：${lostNodes.join("、")}`;
  const own = [...request.requiredNames, ...(request.optionalNames ?? [])];
  const foreign = itinerary
    .filter((day) => Number(day.day) !== request.day)
    .flatMap(spotNames)
    .filter((name) => !own.some((own) => compact(own).includes(compact(name)) || compact(name).includes(compact(own))))
    .filter((name) => compactTitle.includes(compact(name)) && !compact(request.sourceText).includes(compact(name)));
  if (foreign.length) return `出现其他天的景点：${[...new Set(foreign)].join("、")}`;
  return undefined;
}

function spotNames(day: JsonObject): string[] {
  const spots = Array.isArray(day.spots) ? day.spots : [];
  return spots.flatMap((spot) => {
    const name = spot && typeof spot === "object" ? text((spot as JsonObject).name) : "";
    return name ? [name] : [];
  });
}

/** 只有「A · B · C」形式的确定性景点串才拆出节点；路线句子不拆。 */
export function sequenceNames(title: string): string[] {
  if (!title.includes(" · ")) return [];
  return title.split(" · ").map((name) => name.replace(/（二选一）$/u, "").trim())
    .flatMap((name) => name.split("或")).map((name) => name.trim()).filter(Boolean);
}

function compact(value: string): string { return value.replace(/\s+/gu, ""); }
function text(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
