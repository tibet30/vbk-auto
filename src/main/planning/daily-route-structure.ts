import { createHash } from "node:crypto";
import type { LockedItineraryDay } from "../../shared/contracts-preparation.js";
import { isReplayDataMissing } from "../infrastructure/replay-data-error.js";
import { mergedDailyRouteSources, type DailyRouteSource } from "../agent/daily-route-source.js";

/**
 * 逐日路线的 AI 结构化结果。用户的逐日文本千变万化（括号子景点、冒号列举、
 * 车程说明、上午/下午前缀……），不再靠正则逐种穷举；由 AI 读懂后给出有序节点，
 * 本地只做校验：天序完整、每个节点名必须逐字出现在当天原文里。
 * 结果存在 product.diagnostics.dailyRouteStructure，并绑定原文指纹，原文一变即失效。
 */
export type DailyRouteNodeKind = "attraction" | "place" | "highlight";

export interface DailyRouteNode { name: string; kind: DailyRouteNodeKind }

export interface DailyRouteStructure {
  version: 1;
  fingerprint: string;
  days: Array<{ day: number; nodes: DailyRouteNode[] }>;
}

export interface DailyRouteStructureRequest {
  days: DailyRouteSource[];
  /** 上一版被本地校验拒绝的原因，非空时必须针对性修正。 */
  rejectedReason?: string;
}

export type DailyRouteStructureGenerator = (request: DailyRouteStructureRequest) => Promise<Array<{
  day: number;
  nodes: Array<{ name: string; kind: string }>;
}>>;

const KINDS = new Set<string>(["attraction", "place", "highlight"]);

export function routeFingerprint(sources: readonly DailyRouteSource[]): string {
  return createHash("sha256").update(JSON.stringify(sources.map((item) => [item.day, item.text]))).digest("hex");
}

const squash = (value: string) => value.replace(/\s+/gu, "");

/** 「宿韶山」「住韶山」「入住市区」是住宿动作不是景点；宿州 / 宿迁 / 宿松是地名，保留。 */
const LODGING_ACTION_NODE = /^(?:入住|住宿|住(?!宿)|宿(?!州|迁|松))\S{2,}/u;

/** 「出发地」「客源地」是客源城市的占位词，不是任何真实地点，更不是景点。 */
const ORIGIN_PLACEHOLDER_NODE = /^(?:出发地|客源地)$/u;

/** 住宿动作与客源占位都不能成为路线节点。 */
function isNonRouteNode(node: { name: string }): boolean {
  const name = node.name.trim();
  return LODGING_ACTION_NODE.test(name) || ORIGIN_PLACEHOLDER_NODE.test(name);
}

/** 返回拒绝原因；undefined 表示通过。 */
export function dailyRouteStructureProblem(
  sources: readonly DailyRouteSource[],
  days: DailyRouteStructure["days"],
): string | undefined {
  const expected = sources.map((item) => item.day);
  const actual = days.map((item) => item.day);
  if (expected.join(",") !== actual.join(",")) {
    return `天序必须恰好为 ${expected.join("、")}，实际为 ${actual.join("、") || "空"}。`;
  }
  for (const entry of days) {
    const source = squash(sources.find((item) => item.day === entry.day)?.text ?? "");
    const missing = entry.nodes.find((node) => !source.includes(squash(node.name)));
    if (missing) return `第 ${entry.day} 天节点「${missing.name}」没有逐字出现在当天原文中。`;
    const bad = entry.nodes.find((node) => node.name.trim().length < 2 || node.name.length > 20);
    if (bad) return `第 ${entry.day} 天节点「${bad.name}」长度必须为 2-20 个字符。`;
  }
  return undefined;
}

function normaliseDays(raw: Awaited<ReturnType<DailyRouteStructureGenerator>>): DailyRouteStructure["days"] {
  return raw.map((entry) => {
    const seen = new Set<string>();
    const nodes: DailyRouteNode[] = [];
    for (const node of entry.nodes) {
      const name = String(node.name ?? "").trim();
      const key = squash(name);
      if (!name || seen.has(key) || !KINDS.has(node.kind) || isNonRouteNode({ name })) continue;
      seen.add(key);
      nodes.push({ name, kind: node.kind as DailyRouteNodeKind });
    }
    return { day: Number(entry.day), nodes };
  }).sort((left, right) => left.day - right.day);
}

/** 向 AI 要结构，最多两轮；第二轮带上本地拒绝原因。仍不合格返回 undefined（调用方回退正则）。 */
export async function structureDailyRoute(args: {
  userIdea: string;
  generate: DailyRouteStructureGenerator;
  onWarning?: (message: string) => void;
}): Promise<DailyRouteStructure | undefined> {
  const sources = mergedDailyRouteSources(args.userIdea);
  if (!sources.length) return undefined;
  let rejectedReason: string | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const days = normaliseDays(await args.generate({ days: [...sources], ...(rejectedReason ? { rejectedReason } : {}) }));
      rejectedReason = dailyRouteStructureProblem(sources, days);
      if (!rejectedReason) return { version: 1, fingerprint: routeFingerprint(sources), days };
    } catch (error) {
      if (isReplayDataMissing(error)) throw error;
      args.onWarning?.(`AI 逐日路线结构化失败，回退规则解析：${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }
  args.onWarning?.(`AI 逐日路线结构化未通过校验，回退规则解析：${rejectedReason}`);
  return undefined;
}

/** 已存结构与当前原文一致且仍通过校验时，转为锁定的逐日景点。 */
export function storedDailyRouteOrder(product: Record<string, unknown>, userIdea: string): LockedItineraryDay[] | undefined {
  const diagnostics = product.diagnostics;
  const stored = diagnostics && typeof diagnostics === "object" && !Array.isArray(diagnostics)
    ? (diagnostics as Record<string, unknown>).dailyRouteStructure as DailyRouteStructure | undefined : undefined;
  if (!stored || stored.version !== 1 || !Array.isArray(stored.days)) return undefined;
  const sources = mergedDailyRouteSources(userIdea);
  if (!sources.length || stored.fingerprint !== routeFingerprint(sources)) return undefined;
  if (dailyRouteStructureProblem(sources, stored.days)) return undefined;
  return stored.days.flatMap((entry) => {
    // 旧版本存下来的结构可能带住宿节点或「出发地」，读取时同样剔除。
    const nodes = entry.nodes.filter((node) => !isNonRouteNode(node));
    // place 是起终点、中转或落脚城市，只是路程，不是景点。整天没有景点（纯返程日）
    // 时才保留城市，让这一天留在锁定顺序里，由投影写成行政落脚与接送日。
    const attractions = nodes.filter((node) => node.kind === "attraction");
    const spots = (attractions.length ? attractions : nodes.filter((node) => node.kind === "place")).map((node) => node.name);
    const unorderedSpots = nodes.filter((node) => node.kind === "highlight").map((node) => node.name)
      .filter((name) => !spots.includes(name));
    return spots.length || unorderedSpots.length
      ? [{ day: entry.day, spots, ...(unorderedSpots.length ? { unorderedSpots } : {}) }] : [];
  });
}

/** 需要（重新）结构化：原文有逐日路线，且没有与当前原文一致的已验证结果。 */
export function needsDailyRouteStructure(product: Record<string, unknown>, userIdea: string): boolean {
  return mergedDailyRouteSources(userIdea).length > 0 && !storedDailyRouteOrder(product, userIdea);
}
