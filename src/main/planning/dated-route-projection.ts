import type { ProductDetail } from '../../shared/contracts.js';
import { filterPlanningRequirementMessages } from '../agent/prompt-helpers.js';
import { constraintUserIdea } from '../../shared/product-idea-optimization.js';
import { findOperatorItinerarySpotKind } from '../../shared/operator-itinerary-kinds.js';
import { hasTrustedOperatorItineraryRemoval } from '../../shared/trusted-operator-itinerary-removals.js';
import { poiResearchTaskNames } from '../../shared/poi-research-tasks.js';
import { toPlatformShortLocationName } from '../../shared/location-short-name.js';
import { storedRouteNodeNames, structuredOvernightName } from './daily-route-structure.js';

type Json = Record<string, any>;
type RouteDay = { day: number; route: string; names: string[]; notes: string[] };

const NO_POI_EVIDENCE_MARKER = '[itinerary-kind:no-poi]';

/** Only complete arrow routes qualify; prose and later corrections retain the planner. */
export function completeDatedRoute(product: ProductDetail): RouteDay[] | undefined {
  const basic = product.product.basicInfo as Json;
  const days = Number(basic?.days);
  const raw = constraintUserIdea(basic).replace(/\*\*/gu, '');
  const rows = raw.split(/[\n\r]+/u).filter(line => line.trim()).map(line => {
    const match = line.match(/^\s*(?:\d{1,2}\s*月\s*\d{1,2}\s*号\s*)?D(\d{1,2})\s*[:：]\s*(.+)$/iu);
    if (!match || !/[-—–→]/u.test(match[2]!)) return undefined;
    const route = match[2]!.trim();
    const notes = [...route.matchAll(/[（(]([^）)]+)[）)]/gu)].map(match => match[1]!.trim());
    if (notes.some(note => !/星空|观星/u.test(note))) return undefined;
    // `| 宿祁连`、`| 张掖结束行程` 是住宿/收尾注记，不是同一条路线上的景点节点：
    // 混进名字会让「必须保留原文」校验要求整串出现（历史上由此产生死循环）。
    const [mainRoute, ...tails] = route.replace(/[（(][^）)]+[）)]/gu, '').split(/[|｜]/u);
    const tailNames = tails.map(name => name.trim())
      .filter(name => name && !/^(?:宿|住)/u.test(name) && !/(?:结束行程|散团|返程|送站|送机)/u.test(name))
      // 尾巴里的服务/活动说明（「含门票」「泡温泉」「含讲解」）不是路线节点，
      // 当成景点会平白要求绑定 POI。
      .filter(name => !/^(?:含|不含|门票|讲解|用餐|自理|车程|公里|小时|接驳|包车|专车|泡|体验|赠送|安排)/u.test(name));
    const names = [...mainRoute!.split(/\s*[-—–→]+\s*/u), ...tailNames].map(name => name.trim()).filter(Boolean);
    if (names.length < 2 || names.some(name => /[。；;，,]|或者|二选一|住宿|入住/u.test(name))) return undefined;
    return { day: Number(match[1]), route, names, notes };
  });
  if (!Number.isInteger(days) || rows.length !== days || rows.some(row => !row)) return undefined;
  const complete = rows as RouteDay[];
  if (new Set(complete.map(row => row.day)).size !== days || complete.some(row => row.day < 1 || row.day > days)) return undefined;
  // 名字切分同样交给 AI：结构里已校验的节点顺序替代按箭头/竖线切词。
  // 只有结构完整覆盖当天原文时才替换，否则保持原有切分，避免标题凭空变短。
  const structured = storedRouteNodeNames(product.product as Json);
  return complete.sort((a, b) => a.day - b.day).map(row => {
    const names = structured.get(row.day);
    if (!names || names.length < 2) return row;
    const squashed = row.route.replace(/\s+/gu, '');
    return names.every(name => squashed.includes(name.replace(/\s+/gu, ''))) ? { ...row, names } : row;
  });
}

/** Preserve every route endpoint and night note without choosing new attractions or times. */
export function projectDatedRoute(product: ProductDetail): Json[] | undefined {
  const route = completeDatedRoute(product);
  if (!route) return undefined;
  const nights = Number((product.product.basicInfo as Json)?.nights);
  return route.map(row => {
    // 当晚住宿城市优先用 AI 从原文读出的住宿地；没有结构时交给下游规则解析兜底。
    const stay = row.day <= nights ? structuredOvernightName(product.product as Json, row.day) : undefined;
    const stayCity = stay ? writableHotelCity(stay) : undefined;
    return {
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
      ...(stayCity ? { hotelCity: stayCity } : {}),
      meals: '自理',
    };
  });
}

/**
 * Administrative receipts exempt POI mapping, never the original transport/experience text.
 *
 * 运营已经结算过的条目不能再反过来要求出现在文案里：手动删除（trusted removal）、
 * 手动改成自由活动/其他（人工类型凭证，含历史 no-poi 核查证据）、行政落脚点、
 * 以及住宿端点城市。旧实现逐字要求整条原始路线出现，删除后必然自相矛盾，
 * 「继续执行」会在同一处反复失败并顺手把人工修改覆盖掉。
 */
export function datedRouteDetailError(product: ProductDetail, itinerary: Json[]): string | undefined {
  const original = constraintUserIdea(product.product.basicInfo);
  if (filterPlanningRequirementMessages(product.messages ?? []).some(message => message.content.trim() !== original)) return undefined;
  const route = completeDatedRoute(product);
  if (!route) return undefined;
  for (const row of route) {
    const day = itinerary.find(day => Number(day.day) === row.day);
    if (!day) continue;
    const words = [day.title, day.description, ...(day.activities ?? []).flatMap((item: Json) => [item.title, item.detail]),
      ...(day.spots ?? []).flatMap((item: Json) => [item.name, item.poiName, item.description])].filter(value => typeof value === 'string').join(' ').replace(/\s+/gu, '');
    for (const name of [...row.names, ...row.notes]) {
      if (operatorSettledName(product, row.day, name)) continue;
      if (!words.includes(name.replace(/\s+/gu, ''))) return `第 ${row.day} 天未保留用户原始路线安排「${name}」。`;
    }
  }
  return undefined;
}

/** 该名字是否已经由运营结算，不再需要逐字出现在当天文案里。 */
function operatorSettledName(product: ProductDetail, day: number, name: string): boolean {
  const current = product.product as Json;
  if (hasTrustedOperatorItineraryRemoval(current, day, name)) return true;
  if (isProductAnchorCity(product, name)) return true;
  if (isOvernightEndpoint(product, day, name)) return true;
  const recorded = findOperatorItinerarySpotKind(current, day, name);
  if (recorded) return recorded.kind !== 'attraction';
  return legacyNonPoiEvidence(product, name);
}

/** 历史数据没有人工类型凭证时，按核查任务里的 no-poi 证据识别。 */
function legacyNonPoiEvidence(product: ProductDetail, name: string): boolean {
  const key = name.replace(/\s+/gu, '');
  return (product.researchTasks ?? []).some(task => {
    if (task.type !== 'vbk' && task.type !== 'web') return false;
    const evidenced = (task.evidence ?? []).some(item => item?.accepted === true
      && typeof item.title === 'string' && item.title.includes(NO_POI_EVIDENCE_MARKER));
    if (!evidenced) return false;
    return poiResearchTaskNames(task.label, task.type).some(taskName => taskName.replace(/\s+/gu, '') === key);
  });
}

/**
 * 产品锚点城市（集合/目的地/取还车城市）由 basicInfo / operations 承载，
 * 不要求每天都在文案里复述。已核验的路线行政节点不在此列：它们仍是原路线
 * 的一部分，文案里丢掉就该报错。
 */
function isProductAnchorCity(product: ProductDetail, name: string): boolean {
  const basic = (product.product.basicInfo ?? {}) as Json;
  const operations = (product.product.operations ?? {}) as Json;
  const traffic = (operations.trafficLine ?? {}) as Json;
  const short = toPlatformShortLocationName(name);
  if (!short) return false;
  return [basic.meetingCity, basic.destinationCity, basic.destination, operations.pickupCity,
    traffic.arrivalCity, traffic.departureCity]
    .some((value) => typeof value === 'string' && toPlatformShortLocationName(value) === short);
}

/** 当天的出发城市通常就是前一晚的住宿地：住宿字段已经承载它，不要求再写进当日文案。 */
function isOvernightEndpoint(product: ProductDetail, day: number, name: string): boolean {
  const short = toPlatformShortLocationName(name);
  if (!short) return false;
  const days = Array.isArray(product.product.itinerary) ? product.product.itinerary as Json[] : [];
  // 只认「前一晚」：当天自己的 hotelCity 可能正是由本投影从路线终点写出的，
  // 拿它豁免当天的路线点会变成自证通过。
  const previous = days.find(candidate => Number(candidate.day) === day - 1);
  const city = previous?.hotelCity;
  return typeof city === 'string' && toPlatformShortLocationName(city) === short;
}

/**
 * 住宿落点写进 hotelCity 前的可写城市校验：镇/村/乡/景区/古镇等不是平台行政城市，
 * 只能留在文案里，不能写进行政字段（与完整投影的 writableStayCity 同一口径）。
 */
function writableHotelCity(stay: string): string | undefined {
  const city = toPlatformShortLocationName(stay);
  if (!city) return undefined;
  if (/(?:镇|村|乡|景区|风景区|片区|园区|街区|社区|古城|古镇)$/u.test(city)) return undefined;
  return city;
}
