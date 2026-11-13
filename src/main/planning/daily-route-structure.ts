import { createHash } from "node:crypto";
import type { LockedItineraryDay } from "../../shared/contracts-preparation.js";
import { constraintUserIdea } from "../../shared/product-idea-optimization.js";
import { isReplayDataMissing } from "../infrastructure/replay-data-error.js";
import { mergedDailyRouteSources, type DailyRouteSource } from "../agent/daily-route-source.js";

/**
 * 逐日路线的 AI 结构化结果。用户的逐日文本千变万化（括号子景点、冒号列举、
 * 车程说明、上午/下午前缀……），不再靠正则逐种穷举；由 AI 读懂后给出有序节点，
 * 本地只做校验：天序完整、每个节点名必须逐字出现在当天原文里。
 * 结果存在 product.diagnostics.dailyRouteStructure，并绑定原文指纹，原文一变即失效。
 */
export type DailyRouteNodeKind = "attraction" | "place" | "highlight";

export interface DailyRouteNode {
  name: string;
  kind: DailyRouteNodeKind;
  /** 「甲或乙」「二选一」的候选：同组节点必须相邻且按原文顺序，组内成员都标 or。 */
  relation?: "or";
}

/**
 * 当晚住宿地同样交给 AI 读原文，而不是让下游用正则穷举「宿X / 住X / 夜宿X」。
 * 本地只校验：必须逐字出自当天原文、长度合法、不是住宿动作短语。
 */
export interface DailyRouteOvernight { name: string }

export interface DailyRouteStructure {
  /** 1 = 只有节点；2 = 节点 + 当晚住宿地（见 DailyRouteOvernight）。 */
  version: 1 | 2;
  fingerprint: string;
  days: Array<{ day: number; nodes: DailyRouteNode[]; overnight?: DailyRouteOvernight }>;
}

export interface DailyRouteStructureRequest {
  days: DailyRouteSource[];
  /** 上一版被本地校验拒绝的原因，非空时必须针对性修正。 */
  rejectedReason?: string;
}

export type DailyRouteStructureGenerator = (request: DailyRouteStructureRequest) => Promise<Array<{
  day: number;
  nodes: Array<{ name: string; kind: string; relation?: string }>;
  /** AI 从当天原文读出的当晚住宿地；原文没写住宿就省略。 */
  overnight?: string;
}>>;

const KINDS = new Set<string>(["attraction", "place", "highlight"]);

/**
 * 「甲或乙」由 AI 从原文读出并标 relation=or，本地只校验：候选相邻成组、
 * 组内至少两项、组间原文确实出现选择标记，避免模型凭空造出二选一。
 */
export function dailyRouteAlternativeGroups(days: DailyRouteStructure["days"]): Array<{ day: number; names: string[] }> {
  return days.flatMap((entry) => {
    const groups: Array<{ day: number; names: string[] }> = [];
    let run: string[] = [];
    for (const node of [...entry.nodes, { name: "", relation: undefined }]) {
      if (node.relation === "or") { run.push(node.name); continue; }
      if (run.length > 1) groups.push({ day: entry.day, names: run });
      run = [];
    }
    return groups;
  });
}

function alternativeGroupProblem(source: string, nodes: DailyRouteNode[]): string | undefined {
  const groups: Array<{ first: string; last: string; size: number }> = [];
  let run: DailyRouteNode[] = [];
  for (const node of [...nodes, { name: "", kind: "place" as const, relation: undefined }]) {
    if (node.relation === "or") { run.push(node); continue; }
    if (run.length) groups.push({ first: run[0]!.name, last: run[run.length - 1]!.name, size: run.length });
    run = [];
  }
  for (const group of groups) {
    if (group.size < 2) return `候选「${group.first}」必须与同组候选相邻成组，至少两项。`;
    const first = squash(group.first);
    const start = source.indexOf(first);
    const end = source.indexOf(squash(group.last), start + first.length);
    if (start < 0 || end < 0) return `候选「${group.first}」「${group.last}」没有按原文顺序相邻出现。`;
    const between = source.slice(start + first.length, end);
    // 选择标记可以写在候选之间（「A 或 B」），也可以紧跟候选之后
    // （「A、B 任选其一」），也可以写在候选之前（「（二选一：A、B）」）。
    const lastEnd = end + squash(group.last).length;
    const marker = /(?:或者|或|二选一|多选一|任选其一|任选|\/|／)/u;
    // 候选之间只接受分隔符与选择标记本身：「韶山（含接送或自理）— 滴水洞」里的
    // 「或」属于服务说明，不能当成这两个候选的二选一。
    const betweenMarker = /^[\s、，,·|｜/／（）()\-—–]*(?:或者|或|二选一|多选一|任选其一|任选|\/|／)?[\s、，,·|｜/／（）()\-—–]*$/u;
    // 只看候选之后同一句/同一括号内的文字：避免把远处「含接送或自理」里的
    // 「或」误当成这几个候选的二选一标记。
    const tail = source.slice(lastEnd).split(/[。；;\n（）()]/u)[0]!.slice(0, 12);
    // 候选之前的标记限定在同一括号/分句内（最多 12 字），避免跨句误判。
    const head = source.slice(0, start).split(/[（(）)，,、。；;\n]/u).at(-1)!.slice(-12);
    const betweenHasMarker = marker.test(between) && betweenMarker.test(between);
    if (!betweenHasMarker && !marker.test(tail) && !marker.test(head)) {
      return `候选「${group.first}」「${group.last}」附近原文没有选择标记（或/二选一/任选其一）。`;
    }
  }
  return undefined;
}

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
  // 全空结构会被下游当作「已经读懂」：锁定天与景点整体消失，且不会再重试。
  // 允许个别天没有节点（纯接送/返程日），但不允许整天全空；放在逐天字段校验之后，
  // 让住宿地等更具体的拒绝原因先回灌模型。
  let anyNode = false;
  for (const entry of days) {
    const source = squash(sources.find((item) => item.day === entry.day)?.text ?? "");
    const missing = entry.nodes.find((node) => !source.includes(squash(node.name)));
    if (missing) return `第 ${entry.day} 天节点「${missing.name}」没有逐字出现在当天原文中。`;
    const bad = entry.nodes.find((node) => node.name.trim().length < 2 || node.name.length > 20);
    if (bad) return `第 ${entry.day} 天节点「${bad.name}」长度必须为 2-20 个字符。`;
    const orProblem = alternativeGroupProblem(source, entry.nodes);
    if (orProblem) return `第 ${entry.day} 天二选一${orProblem}`;
    const overnight = entry.overnight?.name?.trim();
    if (entry.overnight && !overnight) return `第 ${entry.day} 天住宿地不能为空。`;
    if (overnight) {
      if (overnight.length < 2 || overnight.length > 20) return `第 ${entry.day} 天住宿地「${overnight}」长度必须为 2-20 个字符。`;
      if (isNonRouteNode({ name: overnight })) return `第 ${entry.day} 天住宿地「${overnight}」是住宿动作短语，不是地名。`;
      if (!source.includes(squash(overnight))) return `第 ${entry.day} 天住宿地「${overnight}」没有逐字出现在当天原文中。`;
    }
    if (entry.nodes.length) anyNode = true;
  }
  if (!anyNode) return "AI 没有给出任何路线节点，不能把它当成已读懂的原路线。";
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
      const relation = normaliseRelation(node.relation);
      nodes.push({ name, kind: node.kind as DailyRouteNodeKind, ...(relation ? { relation } : {}) });
    }
    const overnight = String(entry.overnight ?? "").trim();
    return { day: Number(entry.day), nodes, ...(overnight ? { overnight: { name: overnight } } : {}) };
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
      if (!rejectedReason) return { version: 2, fingerprint: routeFingerprint(sources), days };
    } catch (error) {
      if (isReplayDataMissing(error)) throw error;
      args.onWarning?.(`AI 逐日路线结构化失败，回退规则解析：${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }
  args.onWarning?.(`AI 逐日路线结构化未通过校验，回退规则解析：${rejectedReason}`);
  return undefined;
}

function readStored(product: Record<string, unknown>): DailyRouteStructure | undefined {
  const diagnostics = product.diagnostics;
  const raw = diagnostics && typeof diagnostics === "object" && !Array.isArray(diagnostics)
    ? (diagnostics as Record<string, unknown>).dailyRouteStructure
    : undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const stored = raw as Record<string, unknown>;
  if ((stored.version !== 1 && stored.version !== 2) || !Array.isArray(stored.days)) return undefined;
  // 持久化 JSON 可能来自历史版本或人工编辑：规整单天形状，畸形只丢该字段，
  // 不把整套结构判成无效（否则下游会以为没有结构而反复重跑 AI）。
  const days = stored.days.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const entry = value as Record<string, unknown>;
    const day = Number(entry.day);
    if (!Number.isInteger(day) || day <= 0) return [];
    const nodes = (Array.isArray(entry.nodes) ? entry.nodes : []).flatMap((item): DailyRouteNode[] => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const node = item as Record<string, unknown>;
      const name = typeof node.name === "string" ? node.name.trim() : "";
      if (!name || !KINDS.has(String(node.kind))) return [];
      const relation = normaliseRelation(node.relation);
      return [{ name, kind: node.kind as DailyRouteNodeKind, ...(relation ? { relation } : {}) }];
    });
    const overnight = normaliseOvernight(entry.overnight);
    return [{ day, nodes, ...(overnight ? { overnight } : {}) }];
  });
  return {
    version: stored.version as 1 | 2,
    fingerprint: typeof stored.fingerprint === "string" ? stored.fingerprint : "",
    days,
  };
}

/** 「甲或乙」标记的宽容归一：兼容模型大小写、全角与中文写法。 */
function normaliseRelation(value: unknown): "or" | undefined {
  if (typeof value !== "string") return undefined;
  return /^(?:or|或|二选一|任选其一|either)$/iu.test(value.trim()) ? "or" : undefined;
}

/** 当晚住宿地既接受 `{ name }`，也接受历史上直接写成字符串的 `"韶山"`。 */
function normaliseOvernight(value: unknown): DailyRouteOvernight | undefined {
  const name = typeof value === "string" ? value.trim()
    : value && typeof value === "object" && !Array.isArray(value) && typeof (value as { name?: unknown }).name === "string"
      ? (value as { name: string }).name.trim()
      : "";
  return name ? { name } : undefined;
}

/**
 * AI 结构里该天的当晚住宿地；结构与当前原文指纹一致才可用，原文一改立即失效。
 * 下游（住宿资源段、行程投影）优先用它，正则只作为没有结构时的兜底。
 */
export function structuredOvernightName(product: Record<string, unknown>, day: number): string | undefined {
  const stored = readStored(product);
  if (!stored) return undefined;
  const basic = product.basicInfo && typeof product.basicInfo === "object" && !Array.isArray(product.basicInfo)
    ? product.basicInfo as Record<string, unknown> : {};
  const sources = mergedDailyRouteSources(constraintUserIdea(basic));
  if (!sources.length || stored.fingerprint !== routeFingerprint(sources)) return undefined;
  return stored.days.find((entry) => Number(entry.day) === Number(day))?.overnight?.name?.trim() || undefined;
}

/**
 * AI 结构里每天的路线节点名（有序列出，按原文顺序）。只有结构与当前原文一致、
 * 且通过校验时才返回；调用方用它替代按分隔符切名字，不再自己切分自然语言。
 */
export function storedRouteNodeNames(product: Record<string, unknown>): Map<number, string[]> {
  const names = new Map<number, string[]>();
  const stored = readStored(product);
  if (!stored) return names;
  const basic = product.basicInfo && typeof product.basicInfo === "object" && !Array.isArray(product.basicInfo)
    ? product.basicInfo as Record<string, unknown> : {};
  const sources = mergedDailyRouteSources(constraintUserIdea(basic));
  if (!sources.length || stored.fingerprint !== routeFingerprint(sources)) return names;
  if (dailyRouteStructureProblem(sources, stored.days)) return names;
  for (const entry of stored.days) {
    const source = squash(sources.find((item) => item.day === entry.day)?.text ?? "");
    const nodes = entry.nodes.filter((node) => !isNonRouteNode(node));
    const ordered = nodes
      // 「… — 张掖结束行程」里的终点城市是收尾注记，不是当天路线节点；
      // 规则解析一直把它排除，AI 结构读取时保持同一语义。
      .filter((node, index) => !(node.kind === "place" && index === nodes.length - 1
        && isClosingNode(source, node.name)))
      .map((node) => node.name);
    if (ordered.length) names.set(Number(entry.day), ordered);
  }
  return names;
}

/** 节点名之后 6 个字内出现「结束行程/散团/返程/送站/送机」→ 它是收尾城市而非路线节点。 */
function isClosingNode(source: string, name: string): boolean {
  const keyword = squash(name);
  // 同名城市可能既是途经点又是收尾点（「张掖 — 七彩丹霞 - 张掖结束行程」），
  // 以最后一次出现为准。
  const at = source.lastIndexOf(keyword);
  if (at < 0) return false;
  return /^(?:结束行程|散团|返程|送站|送机)/u.test(source.slice(at + keyword.length, at + keyword.length + 6));
}

/** AI 结构里已校验的二选一组；结构与原文不一致时为空，调用方回退规则解析。 */
export function structuredAlternativeGroups(product: Record<string, unknown>): Array<{ day: number; names: string[] }> {
  const stored = readStored(product);
  if (!stored) return [];
  const basic = product.basicInfo && typeof product.basicInfo === "object" && !Array.isArray(product.basicInfo)
    ? product.basicInfo as Record<string, unknown> : {};
  const sources = mergedDailyRouteSources(constraintUserIdea(basic));
  if (!sources.length || stored.fingerprint !== routeFingerprint(sources)) return [];
  if (dailyRouteStructureProblem(sources, stored.days)) return [];
  return dailyRouteAlternativeGroups(stored.days);
}

/** 已存结构与当前原文一致且仍通过校验时，转为锁定的逐日景点。 */
export function storedDailyRouteOrder(product: Record<string, unknown>, userIdea: string): LockedItineraryDay[] | undefined {
  const stored = readStored(product);
  if (!stored) return undefined;
  const sources = mergedDailyRouteSources(userIdea);
  if (!sources.length || stored.fingerprint !== routeFingerprint(sources)) return undefined;
  if (dailyRouteStructureProblem(sources, stored.days)) return undefined;
  const rows = stored.days.flatMap((entry) => {
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
  // 全部天都没有可用节点时视为没有结构：宁可回退规则解析，也不能让空数组
  // 冒充「已锁定顺序」（空数组是 truthy，会让下游跳过规则解析）。
  return rows.length ? rows : undefined;
}

/**
 * 需要（重新）结构化：原文有逐日路线，且没有与当前原文一致的已验证结果；
 * 或者已存结构还是 v1（只有节点、没有 AI 读出的住宿地）且产品含住宿夜——
 * 这类结构会迫使下游退回正则猜住宿地，重跑一次让 AI 重新读原文。
 */
export function needsDailyRouteStructure(product: Record<string, unknown>, userIdea: string): boolean {
  if (!mergedDailyRouteSources(userIdea).length) return false;
  if (!storedDailyRouteOrder(product, userIdea)) return true;
  const stored = readStored(product);
  const nights = Number((product.basicInfo as Record<string, unknown> | undefined)?.nights ?? 0);
  return Boolean(stored && stored.version === 1 && nights > 0);
}
