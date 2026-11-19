import type { ProductDetail } from "../../shared/contracts.js";
import { isReplayDataMissing } from "../infrastructure/replay-data-error.js";
import { isPersistedRouteTravelNode } from "../../shared/itinerary-route-travel-node.js";
import { hasItineraryHotelStay } from "../../shared/itinerary-hotel.js";
import { effectiveItinerarySpotKind } from "../../shared/itinerary-activity-kind.js";
import { parseProductBriefMessage } from "../../shared/product-brief-message.js";
import { constraintUserIdea } from "../../shared/product-idea-optimization.js";
import { daySection } from "./day-sections.js";
import {
  ITINERARY_DAY_TITLE_MAX_LENGTH,
  itineraryDayTitleBudget,
  itineraryDayTitleProblem,
} from "../../shared/itinerary-day-title.js";
import {
  dayTitleGrammarProblem,
  itineraryTitleLength,
  normaliseDayTitle,
  parseDayTitle,
  renderDayTitle,
  type DayTitleFacts,
  type ParsedDayTitle,
} from "../../shared/day-title-grammar.js";
import { fitDayTitle } from "../../shared/day-title-fit.js";

type JsonObject = Record<string, unknown>;

export interface ItineraryDayTitleRequest {
  day: number;
  maxLength: number;
  requiredNames: string[];
  optionalNames?: string[];
  routeNodes: string[];
  startName: string;
  stayAllowed: boolean;
  stayName: string;
  includeNotes: string[];
  freeActivityOnly: boolean;
  currentTitle: string;
  sourceText: string;
  hotel: string;
  rejectedReason?: string;
}

export type ItineraryDayTitleGenerator = (requests: ItineraryDayTitleRequest[]) => Promise<Array<{ day: number; title: string }>>;

export function dayTitleFacts(product: JsonObject, day: JsonObject): DayTitleFacts {
  const spots = spotNames(day);
  const routeNodes = sequenceNames(text(day.title))
    .filter((name) => isPersistedRouteTravelNode(product, day, name));
  return {
    allowedNames: [...new Set([...spots, ...routeNodes])],
    stayAllowed: hasHotelFact(day),
    freeActivityOnly: isFreeOnlyDay(day),
  };
}

export function fallbackDayTitle(args: {
  day: number;
  title: string;
  names: string[];
  budget: number;
  routeNodes?: string[];
  startName?: string;
  stayName?: string;
  includes?: string;
  facts?: DayTitleFacts;
}): string {
  const { day, title, names, budget, routeNodes = [], startName = "", stayName = "", includes = "" } = args;
  const facts: DayTitleFacts = args.facts ?? { allowedNames: [...names, ...routeNodes], stayAllowed: Boolean(stayName) };
  const existing = fitDayTitle(title, budget, routeNodes, facts);
  // 原标题放得下但不含任何当天事实时信息量为零，仍按事实重组。
  const coversFact = !names.length || names.some((name) => existing.includes(name));
  if (coversFact && !dayTitleGrammarProblem(existing, budget, facts)) return existing;
  const nodes = [...new Set([...names, ...routeNodes])];
  if (!startName && !nodes.length) return `第${day}天行程安排`;
  const parsed: ParsedDayTitle = {
    arrival: "",
    start: startName,
    nodes: nodes.map((name) => ({ name, detail: "" })),
    stay: stayName,
    includes,
  };
  const fitted = fitDayTitle(renderDayTitle(parsed), budget, routeNodes, facts);
  if (!dayTitleGrammarProblem(fitted, budget, facts)) return fitted;
  const minimal = `${startName || nodes[0]}${nodes.length > 1 ? `-${nodes[1]}` : ""}`;
  return minimal ? [...minimal].slice(0, budget).join("") : `第${day}天行程安排`;
}

export function ensureDayTitleFits(product: JsonObject, day: JsonObject): JsonObject {
  const dayNumber = Number(day.day);
  const budget = Math.min(ITINERARY_DAY_TITLE_MAX_LENGTH, itineraryDayTitleBudget(product, dayNumber));
  const facts = dayTitleFacts(product, day);
  const raw = text(day.title);
  const title = normaliseDayTitle(routeLine(raw));
  if (!dayTitleGrammarProblem(title, budget, facts)) return title === raw ? day : { ...day, title };
  const required = requiredNodeNames(product, day);
  const fitted = fitDayTitle(title, budget, required, facts);
  if (!dayTitleGrammarProblem(fitted, budget, facts)) return { ...day, title: fitted };
  return { ...day, title: fallbackDayTitle({ day: dayNumber, title, names: dayNodeNames(day), budget, routeNodes: required, facts }) };
}

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

function requiredNodeNames(product: JsonObject, day: JsonObject): string[] {
  return sequenceNames(text(day.title)).filter((name) => isPersistedRouteTravelNode(product, day, name));
}

function titleRequest(product: JsonObject, day: JsonObject, sourceText: string): ItineraryDayTitleRequest {
  const dayNumber = Number(day.day);
  const facts = dayTitleFacts(product, day);
  const spots = spotNames(day);
  const routeNodes = (facts.allowedNames ?? []).filter((name) => !spots.includes(name)
    && isPersistedRouteTravelNode(product, day, name));
  const parsed = parseDayTitle(text(day.title));
  const first = spots[0];
  const required = [...new Set([...(first ? [first] : []), ...routeNodes])];
  return {
    day: dayNumber,
    maxLength: Math.min(ITINERARY_DAY_TITLE_MAX_LENGTH, itineraryDayTitleBudget(product, dayNumber)),
    requiredNames: required,
    optionalNames: spots.filter((name) => !required.includes(name)),
    routeNodes,
    startName: plainStart(parsed.start) || firstStopName(product, day),
    stayAllowed: hasHotelFact(day),
    stayName: stayLocality(sourceText) || text(day.hotelCity),
    includeNotes: includeNoteCandidates(sourceText),
    freeActivityOnly: facts.freeActivityOnly !== false,
    currentTitle: text(day.title),
    sourceText: sourceText.trim(),
    hotel: text(day.hotel),
  };
}

function titleProblem(product: JsonObject, itinerary: JsonObject[], request: ItineraryDayTitleRequest, title: string): string | undefined {
  const facts: DayTitleFacts = {
    allowedNames: [...request.requiredNames, ...request.routeNodes, ...(request.optionalNames ?? [])],
    stayAllowed: request.stayAllowed,
    freeActivityOnly: request.freeActivityOnly,
  };
  const basic = dayTitleGrammarProblem(title, request.maxLength, facts);
  if (basic) return basic;
  const compactTitle = compact(title);
  const missing = request.requiredNames.filter((name) => !compactTitle.includes(compact(name)));
  if (missing.length) return `缺少当天景点：${missing.join("、")}`;
  const day = itinerary.find((item) => Number(item.day) === request.day) ?? { day: request.day };
  const lostNodes = request.routeNodes.filter((name) => !isPersistedRouteTravelNode(product, { ...day, title }, name));
  if (lostNodes.length) return `途经点须保持独立路线节点：${lostNodes.join("、")}`;
  const own = [...request.requiredNames, ...(request.optionalNames ?? [])];
  const foreign = itinerary
    .filter((item) => Number(item.day) !== request.day)
    .flatMap(spotNames)
    .filter((name) => !own.some((mine) => compact(mine).includes(compact(name)) || compact(name).includes(compact(mine))))
    .filter((name) => compactTitle.includes(compact(name)) && !compact(request.sourceText).includes(compact(name)));
  if (foreign.length) return `出现其他天的景点：${[...new Set(foreign)].join("、")}`;
  const parsed = parseDayTitle(title);
  if (parsed.includes && request.includeNotes.length
    && !request.includeNotes.some((note) => compact(note).includes(compact(parsed.includes))
      || compact(parsed.includes).includes(compact(note)))) {
    return `含项说明须取自当天原文：${parsed.includes}`;
  }
  return undefined;
}

export function itineraryDaySourceText(product: ProductDetail, day: number): string {
  const sources = [constraintUserIdea(product.product.basicInfo), ...(product.messages ?? [])
    .filter((message) => message.role === "user")
    .map((message) => parseProductBriefMessage(message.content)?.userIdea?.trim() || message.content)];
  return sources.map((value) => daySection(value, day).replace(/^[:：、，,\s]+/u, "").trim()).filter(Boolean).at(-1) ?? "";
}

export function routeLine(raw: string): string {
  const line = raw.trim().split(/\r?\n/u)[0] ?? "";
  return line.replace(/[。；;，,\s]+$/u, "").trim();
}

export function sequenceNames(title: string): string[] {
  const parsed = parseDayTitle(title);
  return [parsed.start, ...parsed.nodes.map((node) => node.name)]
    .flatMap((name) => name.split("·"))
    .map((name) => name.trim())
    .filter(Boolean);
}

function firstStopName(product: JsonObject, day: JsonObject): string {
  const nodes = (dayTitleFacts(product, day).allowedNames ?? [])
    .filter((name) => isPersistedRouteTravelNode(product, day, name));
  return nodes[0] ?? "";
}

function hasHotelFact(day: JsonObject): boolean {
  return hasItineraryHotelStay(day.hotel) || Boolean(text(day.hotelCity));
}

function stayLocality(sourceText: string): string {
  const match = sourceText.match(/(?:入住|住)(?:宿)?([^-－—–【，。；、\s]{2,12})/u);
  if (!match) return "";
  const value = match[1]!.trim();
  return /酒店|宾馆|民宿|客栈|安排|条件/u.test(value) ? "" : value;
}

function plainStart(value: string): string {
  return value.replace(/[（(][^）)]*[）)]/gu, "").trim();
}

function isFreeOnlyDay(day: JsonObject): boolean {
  const spots = Array.isArray(day.spots) ? day.spots.filter((spot): spot is JsonObject => Boolean(spot) && typeof spot === "object") : [];
  const activities = Array.isArray(day.activities) ? day.activities as JsonObject[] : [];
  const free = spots.some((spot) => effectiveItinerarySpotKind(spot) === "free") || activities.some((item) => item?.type === "free");
  const attractions = spots.filter((spot) => effectiveItinerarySpotKind(spot) === "attraction");
  return free && !attractions.length;
}

function includeNoteCandidates(sourceText: string): string[] {
  // 只认「含/包含」明确的当天含项；景点后的【配讲解】属于景点属性，不能当含项尾缀。
  const stated = [...sourceText.matchAll(/(?:包含|含)[^，。；：、\n【】]{2,24}/gu)].map((match) => match[0].trim());
  return [...new Set(stated.filter(Boolean))];
}

function dayNodeNames(day: JsonObject): string[] {
  const activities = Array.isArray(day.activities) ? day.activities : [];
  const titles = activities.flatMap((activity) => {
    const item = activity && typeof activity === "object" ? activity as JsonObject : {};
    const type = text(item.type);
    return type && ["meal", "hotel"].includes(type) ? [] : [text(item.title)];
  });
  return [...new Set([...spotNames(day), ...titles].filter(Boolean))];
}

function spotNames(day: JsonObject): string[] {
  const spots = Array.isArray(day.spots) ? day.spots : [];
  return spots.flatMap((spot) => {
    const name = spot && typeof spot === "object" ? text((spot as JsonObject).name) : "";
    return name ? [name] : [];
  });
}

function compact(value: string): string { return value.replace(/\s+/gu, ""); }
function text(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
