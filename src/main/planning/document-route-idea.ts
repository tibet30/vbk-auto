import { lodgingConflict } from './document-lodging-conflict.js';

const IDEA_MAX = 1000;
const DAY_DIGITS: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

/** 行程简表行：DAY n 路线标题：途经点 + 早/午/晚餐标记 + 住宿；只取路线，不取餐食和住宿列。 */
function summaryRoutes(text: string): string[] {
  return [...text.matchAll(/^\s*DAY\s*(\d+)\s+(.+)$/gimu)].map(([, day, rest]) => {
    const cells = rest!.split(/\s+/u).filter(Boolean);
    const mealAt = cells.findIndex((cell, i) => /^(?:0|√)$/u.test(cell) && /^(?:0|√)$/u.test(cells[i + 1] ?? ''));
    const route = (mealAt >= 0 ? cells.slice(0, mealAt) : cells).join('').replace(/[:：]$/u, '').replace(/([^\s：]+)：/u, '$1：');
    return `第${day}天：${route}`;
  });
}

/** 没有简表时，退回「第N天：」详细行程的当日标题。 */
function detailTitles(text: string): string[] {
  const start = text.search(/详细行程\s*[:：]/u);
  const body = start < 0 ? text : text.slice(start);
  return [...body.matchAll(/第\s*([一二三四五六七八九十\d]+)\s*天\s*[:：]\s*([^\n]+)/gu)].map(([, day, title]) => {
    const head = title!.split(/\s+餐\s*[:：]/u)[0]!.replace(/\s+/gu, '').trim();
    return `第${DAY_DIGITS[day!] ?? Number(day)}天：${head}`;
  });
}

/**
 * 规划想法的预填内容：逐字取自文档的每日路线，不经模型改写，因此不会凭空增减景点。
 * 住宿城市有歧义时附待确认提示；超出 1000 字按整行截断。
 */
export function documentRouteIdea(documentText: string, confirmedLodging?: string): string {
  const lines = summaryRoutes(documentText);
  const routes = lines.length ? lines : detailTitles(documentText);
  if (!routes.length) return '';
  const conflict = lodgingConflict(documentText);
  const note = conflict && confirmedLodging ? `第${conflict.day}天住宿城市：${confirmedLodging}（运营确认）`
    : conflict ? `第${conflict.day}天住宿城市待确认：${conflict.summary ? `行程简表写${conflict.summary}，` : ''}详细行程写${conflict.choices}。` : '';
  const kept: string[] = [];
  for (const line of routes) {
    if ([...kept, line, note].filter(Boolean).join('\n').length > IDEA_MAX) break;
    kept.push(line);
  }
  return [...kept, note].filter(Boolean).join('\n');
}
