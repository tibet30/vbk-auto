import type { ProductDetail } from '../../shared/contracts.js';
import { filterPlanningRequirementMessages } from '../agent/prompt-helpers.js';

type Json = Record<string, any>;
type RouteDay = { day: number; route: string; names: string[]; notes: string[] };

/** Only complete arrow routes qualify; prose and later corrections retain the planner. */
export function completeDatedRoute(product: ProductDetail): RouteDay[] | undefined {
  const basic = product.product.basicInfo as Json;
  const days = Number(basic?.days);
  const raw = String(basic?.userIdea ?? '').replace(/\*\*/gu, '');
  const rows = raw.split(/[\n\r]+/u).filter(line => line.trim()).map(line => {
    const match = line.match(/^\s*(?:\d{1,2}\s*月\s*\d{1,2}\s*号\s*)?D(\d{1,2})\s*[:：]\s*(.+)$/iu);
    if (!match || !/[-—–→]/u.test(match[2]!)) return undefined;
    const route = match[2]!.trim();
    const notes = [...route.matchAll(/[（(]([^）)]+)[）)]/gu)].map(match => match[1]!.trim());
    if (notes.some(note => !/星空|观星/u.test(note))) return undefined;
    const names = route.replace(/[（(][^）)]+[）)]/gu, '').split(/\s*[-—–→]+\s*/u).map(name => name.trim()).filter(Boolean);
    if (names.length < 2 || names.some(name => /[。；;，,]|或者|二选一|住宿|入住/u.test(name))) return undefined;
    return { day: Number(match[1]), route, names, notes };
  });
  if (!Number.isInteger(days) || rows.length !== days || rows.some(row => !row)) return undefined;
  const complete = rows as RouteDay[];
  if (new Set(complete.map(row => row.day)).size !== days || complete.some(row => row.day < 1 || row.day > days)) return undefined;
  return complete.sort((a, b) => a.day - b.day);
}

/** Preserve every route endpoint and night note without choosing new attractions or times. */
export function projectDatedRoute(product: ProductDetail): Json[] | undefined {
  const route = completeDatedRoute(product);
  if (!route) return undefined;
  const nights = Number((product.product.basicInfo as Json)?.nights);
  return route.map(row => ({
    day: row.day,
    title: row.names.join(' → '),
    description: `按用户原始路线安排：${row.route}。${row.day <= nights ? '当晚在路线终点区域住宿，具体酒店待核验。' : '当日结束行程，不安排住宿。'}`,
    spots: row.names.map((name, index) => ({ name, kind: 'attraction', poiName: null, poiId: null,
      timeOfDay: index < Math.ceil(row.names.length / 2) ? 'morning' : 'afternoon', relation: 'and' })),
    activities: [
      { time: '不限', title: row.names.join(' → '), detail: row.route, type: 'transport', source: 'user' },
      ...row.notes.map(note => ({ time: '晚上', title: note, detail: `保留用户原定安排：${note}，观星受天气和现场开放条件影响。`, type: 'other', source: 'user' })),
    ],
    hotel: row.day <= nights ? `${row.names.at(-1)}区域酒店（待核验）` : '无',
    meals: '自理',
  }));
}

/** Administrative receipts exempt POI mapping, never the original transport/experience text. */
export function datedRouteDetailError(product: ProductDetail, itinerary: Json[]): string | undefined {
  const original = String((product.product.basicInfo as Json)?.userIdea ?? '').trim();
  if (filterPlanningRequirementMessages(product.messages ?? []).some(message => message.content.trim() !== original)) return undefined;
  const route = completeDatedRoute(product);
  if (!route) return undefined;
  for (const row of route) {
    const day = itinerary.find(day => Number(day.day) === row.day);
    if (!day) continue;
    const words = [day.title, day.description, ...(day.activities ?? []).flatMap((item: Json) => [item.title, item.detail]),
      ...(day.spots ?? []).flatMap((item: Json) => [item.name, item.poiName, item.description])].filter(value => typeof value === 'string').join(' ').replace(/\s+/gu, '');
    for (const name of [...row.names, ...row.notes]) {
      if (!words.includes(name.replace(/\s+/gu, ''))) return `第 ${row.day} 天未保留用户原始路线安排「${name}」。`;
    }
  }
  return undefined;
}
