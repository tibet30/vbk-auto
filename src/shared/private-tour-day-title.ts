import { isPrivateTourForm } from "./product-form.js";

/**
 * 私家团每日小标题模板「前缀｜当天内容」，规则取自携程热销私家团（27 个样本）：
 *   - 前缀只能是白名单之一，全角「｜」恰好出现一次；
 *   - 整行（含首日「【出发地-城市】」）不超过 24 字；
 *   - 城市之间用「-」，同城景点之间用「·」，最多 3 个景点；
 *   - 不得出现 emoji、【】（首日前缀除外）、括号、+、→ 与营销词。
 */
export const PRIVATE_TOUR_DAY_TITLE_PREFIXES = ["专车服务", "专车接机", "专车接站", "专车送机", "专车送站", "自由活动"] as const;
export const PRIVATE_TOUR_DAY_TITLE_MAX_LENGTH = 24;
export const PRIVATE_TOUR_DEFAULT_PREFIX = "专车服务";
export const PRIVATE_TOUR_FREE_PREFIX = "自由活动";
const MAX_SPOTS = 3;
const ARRIVAL_PREFIX = /^【出发地\s*[-－—–]\s*[^】]+】/u;
const MARKETING = /网红|打卡|必游|必去|必玩|精华|经典|超值|豪华|纯玩|尊享|特惠|爆款|绝美|首选|顶级|最美|建议/u;

type Node = { name: string; sep: "-" | "·" };

export function isPrivateTourProduct(product: Record<string, unknown> | undefined): boolean {
  const sales = product?.sales;
  return Boolean(sales) && typeof sales === "object" && isPrivateTourForm((sales as Record<string, unknown>).productForm);
}

export function privateTourDayTitleProblem(title: string, budget: number): string | undefined {
  const value = title.trim();
  if (!value) return "标题为空";
  const length = [...value].length;
  if (length > budget) return `标题 ${length} 字，超过 ${budget} 字`;
  const body = value.replace(ARRIVAL_PREFIX, "");
  if (/[\r\n]/u.test(body)) return "标题不能换行";
  if (/\p{Extended_Pictographic}/u.test(body)) return "标题不能包含 emoji";
  if (/[【】（）()+＋→]/u.test(body)) return "标题不能包含【】、括号、+ 或 →";
  if (MARKETING.test(body)) return "标题不能包含营销词或建议说明";
  const parts = body.split("｜");
  if (parts.length !== 2) return "私家团标题须为「前缀｜当天内容」，「｜」恰好一次";
  if (!(PRIVATE_TOUR_DAY_TITLE_PREFIXES as readonly string[]).includes(parts[0]!.trim())) {
    return `前缀须为 ${PRIVATE_TOUR_DAY_TITLE_PREFIXES.join("、")} 之一`;
  }
  const nodes = contentNodes(parts[1]!);
  if (!nodes.length) return "「｜」后缺少当天内容";
  const spots = spotCount(nodes);
  if (spots > MAX_SPOTS) return `景点 ${spots} 个，最多 ${MAX_SPOTS} 个`;
  return undefined;
}

/**
 * 超长或景点过多时从末尾删景点，始终保留前缀、第一个内容节点和 keep 中的途经节点。
 * 没有合法前缀时补「专车服务」；不在字符中间截断。
 */
export function fitPrivateTourDayTitle(title: string, budget: number, keep: string[]): string {
  const value = title.trim().replace(/[\r\n]+/gu, " ");
  const arrival = value.match(ARRIVAL_PREFIX)?.[0] ?? "";
  const body = value.slice(arrival.length);
  const bar = body.indexOf("｜");
  const head = bar >= 0 ? body.slice(0, bar).trim() : "";
  const known = (PRIVATE_TOUR_DAY_TITLE_PREFIXES as readonly string[]).includes(head);
  const prefix = known ? head : PRIVATE_TOUR_DEFAULT_PREFIX;
  const nodes = contentNodes(cleanContent(known ? body.slice(bar + 1) : body));
  const kept = new Set(keep.map((name) => name.trim()));
  const render = () => `${arrival}${prefix}｜${joinNodes(nodes)}`;
  while (nodes.length > 1 && ([...render()].length > budget || spotCount(nodes) > MAX_SPOTS)) {
    let index = nodes.length - 1;
    while (index > 0 && kept.has(nodes[index]!.name)) index -= 1;
    if (index === 0) break;
    const [removed] = nodes.splice(index, 1);
    if (removed!.sep === "-" && nodes[index]) nodes[index]!.sep = "-";
  }
  return render();
}

/** 用车卡片只用「｜」之后的内容；没有「｜」时原样返回。 */
export function privateTourDayTitleContent(title: string): string {
  const value = title.trim();
  const bar = value.indexOf("｜");
  return bar >= 0 ? value.slice(bar + 1).trim() : value;
}

export function isFreeActivityDayTitle(title: string): boolean {
  return title.trim().replace(ARRIVAL_PREFIX, "").startsWith(`${PRIVATE_TOUR_FREE_PREFIX}｜`);
}

/** 标题内容按「-」「·」拆出的节点名（不含前缀），供必含项与途经点判断。 */
export function privateTourDayTitleNodes(title: string): string[] {
  return contentNodes(cleanContent(privateTourDayTitleContent(title.replace(ARRIVAL_PREFIX, "")))).map((node) => node.name);
}

function cleanContent(content: string): string {
  return content
    .replace(/[（(][^）)]*[）)]/gu, "").replace(/[【】]/gu, "")
    .replace(/\p{Extended_Pictographic}|️/gu, "")
    .replace(new RegExp(MARKETING.source, "gu"), "")
    .replace(/\s*[→—–－]+\s*/gu, "-").replace(/\s*[+＋、｜]\s*|\s+·\s+/gu, "·")
    .trim();
}

function contentNodes(content: string): Node[] {
  const nodes: Node[] = [];
  let sep: Node["sep"] = "-";
  for (const token of content.split(/([-·])/u)) {
    if (token === "-" || token === "·") { if (nodes.length) sep = token; continue; }
    const name = token.trim();
    if (!name) continue;
    nodes.push({ name, sep: nodes.length ? sep : "-" });
    sep = "·";
  }
  return nodes;
}

function joinNodes(nodes: Node[]): string {
  return nodes.map((node, index) => (index ? node.sep : "") + node.name).join("");
}

/** 多段路线中只有一个节点的「-」段是城市/途经节点，其余节点按景点计。 */
function spotCount(nodes: Node[]): number {
  const segments: Node[][] = [];
  for (const node of nodes) {
    if (!segments.length || node.sep === "-") segments.push([node]);
    else segments.at(-1)!.push(node);
  }
  if (segments.length === 1) return nodes.length;
  return segments.reduce((sum, segment) => sum + (segment.length === 1 ? 0 : segment.length), 0);
}
