// 每日行程天标题文法：解析、渲染与校验「[【出发地-城市】]起点-玩法[(拓展)]…[-住落点][【含项】]」骨架。

export const DAY_TITLE_MAX_NODES = 6;
export const DAY_TITLE_MAX_DETAIL_LENGTH = 12;
export const DAY_TITLE_MAX_INCLUDE_LENGTH = 24;
const FREE_LABEL = "自由活动";

const ARRIVAL = /^【出发地\s*[-－—–]\s*[^】]+】/u;
const LEGACY_PREFIX = /^(?:专车服务|专车接机|专车接站|专车送机|专车送站|自由活动)｜/u;
const INCLUDE_TAIL = /【([^【】]*)】$/u;
const STAY_TAIL = /[-－—–]住(?:宿)?([^-－—–【]+)$/u;
const SEPARATOR = /[-－—–]/u;
const DETAIL = /[（(]([^（()）]*)[）)]/u;
const MARKETING = /网红|打卡|必游|必去|必玩|精华|经典|超值|豪华|纯玩|尊享|特惠|爆款|绝美|首选|顶级|最美|建议/u;
const FORBIDDEN = /[/、：:,，\s]/u;
const FREE_WORD = /自由活动/u;

export type DayTitleNode = { name: string; detail: string };

export type ParsedDayTitle = {
  arrival: string;
  start: string;
  nodes: DayTitleNode[];
  stay: string;
  includes: string;
};

export type DayTitleFacts = {
  allowedNames?: string[];
  stayAllowed?: boolean;
  freeActivityOnly?: boolean;
};

export function parseDayTitle(raw: string): ParsedDayTitle {
  const value = raw.trim().replace(/[\r\n]+/gu, " ");
  const arrival = value.match(ARRIVAL)?.[0] ?? "";
  let body = value.slice(arrival.length).replace(LEGACY_PREFIX, "");
  const includeMatch = body.match(INCLUDE_TAIL);
  const includes = includeMatch ? includeMatch[1]!.trim() : "";
  if (includeMatch) body = body.slice(0, body.length - includeMatch[0].length);
  const stayMatch = body.match(STAY_TAIL);
  const stay = stayMatch ? stayMatch[1]!.trim() : "";
  if (stayMatch) body = body.slice(0, body.length - stayMatch[0].length);
  const parts = body.split(SEPARATOR).map((part) => part.trim()).filter(Boolean);
  const [start = "", ...rest] = parts;
  return { arrival, start, nodes: rest.map(parseNode), stay, includes };
}

function parseNode(segment: string): DayTitleNode {
  const match = segment.match(DETAIL);
  if (!match || match.index === undefined) return { name: segment, detail: "" };
  const name = segment.slice(0, match.index).trim();
  const detail = match[1]!.trim();
  return name ? { name, detail } : { name: segment, detail: "" };
}

export function normaliseDayTitle(title: string): string {
  return renderDayTitle(parseDayTitle(title));
}

export function renderDayTitle(parsed: ParsedDayTitle): string {
  const nodes = parsed.nodes.map((node) => (node.detail ? `${node.name}(${node.detail})` : node.name));
  const body = [parsed.start, ...nodes].filter(Boolean).join("-");
  const stay = parsed.stay ? `-住${parsed.stay}` : "";
  const includes = parsed.includes ? `【${parsed.includes}】` : "";
  return `${parsed.arrival}${body}${stay}${includes}`;
}

export function dayTitleGrammarProblem(title: string, budget: number, facts: DayTitleFacts = {}): string | undefined {
  const value = title.trim();
  if (!value) return "标题为空";
  if (/[\r\n]/u.test(value)) return "标题不能换行";
  const length = itineraryTitleLength(value);
  if (length > budget) return `标题 ${length} 字，超过 ${budget} 字`;
  const parsed = parseDayTitle(value);
  const body = value.slice(parsed.arrival.length);
  const withoutInclude = parsed.includes ? body.slice(0, body.length - parsed.includes.length - 2) : body;
  if (/[【】]/u.test(withoutInclude)) return "【】只能用于首日出发前缀与当天含项尾缀";
  if (/\p{Extended_Pictographic}|️/gu.test(body)) return "标题不能包含 emoji";
  if (/[+＋→]/u.test(body)) return "标题不能包含 + 或 →";
  const masked = maskFactNames(withoutInclude, facts.allowedNames ?? []);
  if (FORBIDDEN.test(masked.text)) return "节点之间只能用「-」分隔，不能有 /、、、：、逗号或空格";
  if (parsed.includes.length > DAY_TITLE_MAX_INCLUDE_LENGTH) return `含项说明 ${parsed.includes.length} 字，超过 ${DAY_TITLE_MAX_INCLUDE_LENGTH} 字`;
  if (parsed.stay && facts.stayAllowed === false) return "当天没有住宿事实，不能写住段";
  if (!parsed.start && !parsed.nodes.length) return "标题缺少当天动线内容";
  if (parsed.nodes.length > DAY_TITLE_MAX_NODES) return `当天玩法 ${parsed.nodes.length} 段，最多 ${DAY_TITLE_MAX_NODES} 段`;
  const segments = masked.text.split(SEPARATOR).map((part) => part.trim()).filter(Boolean);
  const nodeProblem = segmentProblem(segments);
  if (nodeProblem) return nodeProblem;
  const plainNodes = segments.slice(1).map((segment) => segment.replace(DETAIL, "").trim());
  if (plainNodes.some((name) => MARKETING.test(name))) return "玩法节点不能包含营销词或建议说明";
  const nodeNames = parsed.nodes.map((node) => node.name);
  if (new Set(nodeNames).size !== nodeNames.length) return "玩法节点不能重复";
  if (parsed.start && nodeNames.includes(parsed.start)) return "玩法节点不能与起点重复";
  const detailProblem = detailSpotsProblem(parsed.nodes, facts.allowedNames ?? []);
  if (detailProblem) return detailProblem;
  if (facts.freeActivityOnly === false && parsed.nodes.length
    && parsed.nodes.every((node) => FREE_WORD.test(node.name))) {
    return "当天不是自由活动日，不能只写自由活动";
  }
  return undefined;
}

function detailSpotsProblem(nodes: DayTitleNode[], allowedNames: string[]): string | undefined {
  const names = [...new Set(allowedNames.map((name) => name.trim()).filter(Boolean))];
  for (const node of nodes) {
    if (!node.detail) continue;
    const extra = names.filter((name) => name !== node.name && node.detail.includes(name));
    if (extra.length) return `括号拓展不能塞入其他景点：${extra.join("、")}`;
  }
  return undefined;
}

function segmentProblem(segments: string[]): string | undefined {
  for (const segment of segments) {
    const opens = (segment.match(/[（(]/gu) ?? []).length;
    const closes = (segment.match(/[）)]/gu) ?? []).length;
    if (opens !== closes) return "括号必须成对";
    if (opens > 1) return "每段最多一个括号拓展";
    const match = segment.match(DETAIL);
    if (!match) continue;
    if (!match[1]!.trim()) return "括号拓展不能为空";
    if (match.index !== undefined && match.index + match[0].length !== segment.length) {
      return "括号拓展必须紧跟在该段点位之后";
    }
    if ([...match[1]!.trim()].length > DAY_TITLE_MAX_DETAIL_LENGTH) {
      return `括号拓展 ${match[1]!.trim().length} 字，超过 ${DAY_TITLE_MAX_DETAIL_LENGTH} 字`;
    }
  }
  return undefined;
}

export function dayTitleTransportCopy(title: string): string {
  const parsed = parseDayTitle(title);
  return renderDayTitle({ ...parsed, arrival: "", stay: "", includes: "" });
}

export function isFreeActivityDayTitle(title: string): boolean {
  const value = title.trim();
  if (value.slice(value.match(ARRIVAL)?.[0].length ?? 0).startsWith(`${FREE_LABEL}｜`)) return true;
  const parsed = parseDayTitle(value);
  if (parsed.nodes.length) return parsed.nodes.every((node) => FREE_WORD.test(node.name));
  return FREE_WORD.test(parsed.start);
}

export function itineraryTitleLength(title: string): number {
  return [...title.trim()].length;
}

function maskFactNames(value: string, names: string[]): { text: string; restore: (masked: string) => string } {
  const unique = [...new Set(names.map((name) => name.trim()).filter(Boolean))].sort((b, a) => b.length - a.length);
  let text = value;
  unique.forEach((name, index) => { text = text.split(name).join(`\uE000${String.fromCharCode(0xE100 + index)}`); });
  const restore = (masked: string) => masked.replace(/\uE000([\uE100-\uF8FF])/gu, (_, code: string) => unique[code.charCodeAt(0) - 0xE100]!);
  return { text, restore };
}
