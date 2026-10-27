/**
 * 逐日行程文本切分：把「第N天 / DN / Day N」标记之间的正文切出来。
 *
 * 切分必须落在**行边界**上，这是唯一的不变量：
 *   - 段首：`【第1天 吉林集合】` 这种天头里的 `】` 留在正文里，由调用方的
 *     景点切分逻辑当分隔符处理；行首的 `【` 属于天头，不能留给上一段。
 *   - 段尾：下一个 day 标记若在新的一行，正文只能取到该行行首，否则会把
 *     下一行行首的 `【` 一起吞进来，最终变成标题尾部的「入 【」。
 *   - 最后一天：遇到行首的非 day 分节标题（如 `【服务包含建议】`）就截断，
 *     否则整段服务说明会被当成当日景点。
 *
 * 原实现直接用 `下一标记 index` 截尾，上面三条全部不成立，是产品
 * 4b10616c「每日行程」标题错乱的根因，因此收敛到这里共用。
 */

const DAY_TOKEN: Record<string, number> = {
  "1": 1, "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 7, "8": 8, "9": 9, "10": 10,
  一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
};

const DAY_MARKER = /(?:D(?:ay)?\s*([0-9一二三四五六七八九十]+)\s*天?|第\s*([0-9一二三四五六七八九十]+)\s*天)/gi;

export interface DaySection {
  day: number;
  /** 天头 + 正文的完整文本；用于保留「原始逐日安排」原文。 */
  body: string;
  /** 天头（`【第N天 城市—景点】` 中括号内文字），没有天头时为空。 */
  head: string;
  /** 当日可解析景点正文：天头是路线摘要时不重复计入景点。 */
  content: string;
}

export function daySections(value: string): DaySection[] {
  const source = value.replace(/\\[nr]/gu, "\n");
  const matches = [...source.matchAll(DAY_MARKER)];
  const sections: DaySection[] = [];
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index]!;
    const token = match[1] ?? match[2] ?? "";
    const day = DAY_TOKEN[token] ?? Number(token);
    if (!Number.isInteger(day) || day < 1) continue;
    const start = (match.index ?? 0) + match[0].length;
    const end = sectionEnd(source, start, matches[index + 1]?.index);
    const raw = source.slice(start, Math.max(start, end));
    const { head, content } = splitDayHead(raw);
    sections.push({ day, body: stripDayHead(raw), head, content });
  }
  return sections;
}

/**
 * 天头与正文分离：`【第2天 吉林—雾凇长廊—松花湖】雾凇长廊晨景→…` 的天头
 * 只是路线摘要，不能把「吉林」「松花湖」再当成当日景点；括号后没有正文时
 * （`【第1天 吉林集合】`）仍把天头当作当日内容。
 *
 * 行内标记（`帕拉庄园【配讲解】`）的 `【` 在 `】` 之前，不按天头处理。
 */
function splitDayHead(body: string): { head: string; content: string } {
  const lineEnd = body.indexOf("\n");
  const line = lineEnd < 0 ? body : body.slice(0, lineEnd);
  const close = line.indexOf("】");
  const open = line.indexOf("【");
  if (close < 0 || (open >= 0 && open < close)) return { head: "", content: body };
  const head = line.slice(0, close).trim();
  const afterHead = `${line.slice(close + 1)}\n${lineEnd < 0 ? "" : body.slice(lineEnd + 1)}`.trim();
  return { head, content: afterHead || head };
}

/** 同一天出现多次时取第一次（与历史 `findIndex` 语义一致）。 */
export function daySection(value: string, day: number): string {
  return daySections(value).find((section) => section.day === day)?.body ?? "";
}

/**
 * `第1天 吉林集合】24小时接机` 的天头闭合符 `】` 不属于正文。天头文字本身要保留
 * （它常常就是当日路线起点），因此只把闭合符换成分隔符，避免 `】` 粘到第一个
 * 景点名上（历史上会拼出「松花湖】雾凇长廊晨景」）。
 * `【配讲解】` 这类行内标记有配对的 `【`，不在此列。
 */
function stripDayHead(body: string): string {
  const lineEnd = body.indexOf("\n");
  const line = lineEnd < 0 ? body : body.slice(0, lineEnd);
  const close = line.indexOf("】");
  const open = line.indexOf("【");
  if (close < 0 || (open >= 0 && open < close)) return body;
  return `${line.slice(0, close)}，${body.slice(close + 1)}`;
}

function sectionEnd(source: string, start: number, next: number | undefined): number {
  if (next === undefined) {
    // 最后一天：只在**换行后**的 `【…】` 处截断；正文开头的
    // `【出发地-成都】接站` 是自己的内容，不能当作分节标题。
    const tail = source.slice(start);
    const heading = /(?:\r?\n)[ \t]*【[^】\n]*】/u.exec(tail);
    return heading ? start + (heading.index ?? 0) : source.length;
  }
  const lineStart = source.lastIndexOf("\n", next - 1) + 1;
  // 同一行内的下一个标记（`D1 甲 D2 乙`）不能按行回退。
  return lineStart > start ? lineStart : next;
}
