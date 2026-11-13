import type { DocumentDayPlan, DocumentMeal } from '../../shared/product-document.js';
import { toPlatformShortLocationName } from '../../shared/location-short-name.js';

/**
 * 文档建品的逐日安排规范（规划想法的唯一来源结构）。
 *
 * 模型只负责从文档里读出每天的路线、景点、餐食和住宿；本地校验每个名称都逐字
 * 出现在文档中，天序完整，再渲染为历史产品通用的逐日写法：
 *   D2：【巫山-奉节】巫峡-船观神女峰-三峡之巅-住奉节（含早餐）
 * 该写法与 day-sections、住宿要求、二选一解析的既有约定一致：
 *   - 【起点-终点】是路线天头，不会被当成景点；
 *   - 「住X」是当晚住宿行政城市，候选城市用「或」连接且不会锁成景点二选一；
 *   - 括号里的餐食说明不会进入景点或住宿城市。
 */
export const DOCUMENT_MEALS: readonly DocumentMeal[] = ['早餐', '午餐', '晚餐'];

export const DOCUMENT_ITINERARY_SCHEMA = {
  type: 'array',
  description: '按文档逐日输出完整行程，每天一条，天序从 1 连续到最后一天。',
  items: {
    type: 'object', additionalProperties: false, required: ['day', 'route', 'spots', 'meals', 'lodging'],
    properties: {
      day: { type: 'integer', minimum: 1 },
      route: { type: 'string', description: '当日起止地点，用“-”连接，逐字取自文档，例如“巫山-奉节”' },
      spots: { type: 'array', items: { type: 'string' }, description: '当天游览景点，按文档顺序，名称逐字取自文档，去掉【】' },
      meals: { type: 'array', items: { type: 'string', enum: [...DOCUMENT_MEALS] }, description: '文档写明当天包含的餐食' },
      lodging: { type: 'string', description: '当晚住宿行政城市短名；文档给出二选一时直接选择一个可住宿的县市，乡镇村与县市并列时选县市；返程日或无住宿留空' },
    },
  },
} as const;

export const DOCUMENT_ITINERARY_RULES = 'itinerary 必须覆盖文档的每一天，天数与 days 一致。spots 只写可游览的景点、景区、街区或观景台，'
  + '不写餐厅、酒店、接送、车程、自费或自愿项目、“自由活动”等说明，不得增加文档没有的景点。'
  + 'lodging 只写行政城市短名（如“奉节”），不写酒店名；“温馨的家”等返程表述留空。'
  + '同一晚有两个住宿选项时无需询问，直接选择一个具备住宿条件的行政县市；乡、镇、村、景区与县市并列时选择县市，两个县市都可住宿时任选其一，lodging 只输出选中的一项。';

const squash = (value: string) => value.replace(/[\s【】]+/gu, '');
const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';
const RETURN_HOME = /家$|^(?:返程|散团|各地|全国各地|出发地)$/u;

/** 把模型原始结果整理成规范结构；无法识别的项目丢弃，留给校验报告缺失。 */
export function normaliseDocumentItinerary(raw: unknown): DocumentDayPlan[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item): DocumentDayPlan[] => {
    if (!item || typeof item !== 'object') return [];
    const row = item as Record<string, unknown>;
    const route = text(row.route).replace(/[【】\s]/gu, '').replace(/[—–→>]+/gu, '-').replace(/-+/gu, '-').replace(/^-|-$/gu, '');
    const spots = [...new Set((Array.isArray(row.spots) ? row.spots : []).map(spot => text(spot).replace(/[【】]/gu, '')).filter(Boolean))];
    const meals = DOCUMENT_MEALS.filter(meal => Array.isArray(row.meals) && row.meals.includes(meal));
    const lodging = [...new Set(text(row.lodging).split(/[/／、或]/u).map(city => toPlatformShortLocationName(city.trim()))
      .filter(city => city && !RETURN_HOME.test(city)))];
    return [{ day: Number(row.day), route, spots, meals, lodging }];
  }).sort((left, right) => left.day - right.day);
}

/** 返回拒绝原因；undefined 表示每一天都有安排且名称全部逐字取自文档。 */
export function documentItineraryProblem(plan: DocumentDayPlan[], documentText: string, days: number): string | undefined {
  if (!plan.length) return '缺少逐日行程';
  const expected = days || plan.length;
  if (plan.length !== expected || plan.some((day, index) => day.day !== index + 1)) {
    return `逐日行程必须恰好覆盖第 1 至 ${expected} 天，实际为 ${plan.map(day => day.day).join('、')}`;
  }
  const source = squash(documentText);
  for (const day of plan) {
    if (!day.route && !day.spots.length) return `第 ${day.day} 天没有安排`;
    const unknown = [...day.route.split('-'), ...day.spots, ...day.lodging].find(name => name && !source.includes(squash(name)));
    if (unknown) return `第 ${day.day} 天的「${unknown}」没有出现在文档中`;
    const long = [...day.spots, ...day.lodging].find(name => name.length < 2 || name.length > 20);
    if (long) return `第 ${day.day} 天的「${long}」长度必须为 2-20 字`;
  }
  return undefined;
}

/** 文档并列的住宿城市：运营已回答时只保留该城市，否则保留全部候选待确认。 */
export function applyLodgingDecision(plan: DocumentDayPlan[], day: number, choices: string[], confirmed?: string): DocumentDayPlan[] {
  return plan.map(row => row.day !== day ? row : { ...row, lodging: confirmed ? [confirmed] : choices });
}

const NON_ADMINISTRATIVE_STAY = /(?:乡|镇|村|景区|园区|片区|街区|社区|校区|厂区|矿区|库区)$/u;

/**
 * 从文档住宿二选一中选择可写入酒店平台的行政城市；模型选择有效时优先保留。
 *
 * 只接受行政县市：住宿城市要直接落 `hotelCity`，写成古镇、乡、村或景区会让平台
 * 查不到住宿；两个候选都不是行政县市时返回 undefined，交回原来的「待确认」，
 * 由运营给出可住宿的城市。
 */
export function chooseDocumentLodging(choices: string[], proposed: string[] = []): string | undefined {
  const candidates = [...new Set(choices.map(toPlatformShortLocationName).filter(Boolean))];
  const valid = candidates.filter(city => !NON_ADMINISTRATIVE_STAY.test(city));
  const proposedChoice = proposed.map(toPlatformShortLocationName).find(city => valid.includes(city));
  return proposedChoice || valid[0];
}

const CN_DIGITS = '零一二三四五六七八九';
/** 中文序数：待确认事项不能写阿拉伯数字的「第N晚」，否则住宿要求解析会把它当成当晚住宿。 */
export function chineseOrdinal(value: number): string {
  if (value < 10) return CN_DIGITS[value]!;
  const tens = Math.floor(value / 10);
  return `${tens > 1 ? CN_DIGITS[tens] : ''}十${value % 10 ? CN_DIGITS[value % 10] : ''}`;
}

/** 住宿城市仍有多个候选的晚次，作为待确认事项。 */
export function pendingLodging(plan: DocumentDayPlan[]): string[] {
  return plan.filter(day => day.lodging.length > 1)
    .map(day => `第${chineseOrdinal(day.day)}晚住宿城市待确认：文档写${day.lodging.join('或')}`);
}

function dayLine(day: DocumentDayPlan, withMeals: boolean): string {
  const head = day.route ? `【${day.route}】` : '';
  const stops = [...day.spots, ...(day.lodging.length ? [`住${day.lodging.join('或')}`] : [])];
  const meals = withMeals ? `（${day.meals.length ? `含${day.meals.join('、')}` : '不含餐'}）` : '';
  return `D${day.day}：${head}${stops.join('-')}${meals}`;
}

/** 规划想法的规范文本：逐日一行，最后是待确认事项；超长时先省略餐食，再整行截断。 */
export function renderDocumentItinerary(plan: DocumentDayPlan[], pending: string[], max: number): string {
  const notes = pending.length ? [`【待确认】${pending.join('；')}`] : [];
  for (const withMeals of [true, false]) {
    const lines = [...plan.map(day => dayLine(day, withMeals)), ...notes];
    if (lines.join('\n').length <= max) return lines.join('\n');
  }
  const kept: string[] = [];
  for (const line of plan.map(day => dayLine(day, false))) {
    if ([...kept, line, ...notes].join('\n').length > max) break;
    kept.push(line);
  }
  return [...kept, ...notes].join('\n');
}
