import { arrivalTitlePrefix } from './itinerary-arrival-title.js';
import { PRIVATE_TOUR_DAY_TITLE_MAX_LENGTH, isPrivateTourProduct } from './private-tour-day-title.js';

/**
 * 天标题写入 VBK `dailyDescription`，平台对超长标题直接 Ack=Failure
 * （产品 ae3316d7：88/167 字被拒；已成功录入的最长 70 字）。上限按字符计数，
 * 首日会被追加「【出发地-城市】」前缀，生成侧必须为前缀预留预算。
 */
export const ITINERARY_DAY_TITLE_MAX_LENGTH = 70;

export function itineraryDayTitleLength(title: string): number {
  return [...title.trim()].length;
}

/** 当天标题（不含首日前缀）可用的字符预算；私家团整行按 24 字计。 */
export function itineraryDayTitleBudget(product: Record<string, unknown>, day: number): number {
  const prefix = day === 1 ? arrivalTitlePrefix(product) : '';
  const limit = isPrivateTourProduct(product) ? PRIVATE_TOUR_DAY_TITLE_MAX_LENGTH : ITINERARY_DAY_TITLE_MAX_LENGTH;
  return limit - [...prefix].length;
}

/** 标题只做一行摘要：不能带换行、分节括号或「建议」类说明。 */
export function itineraryDayTitleProblem(title: string, budget: number): string | undefined {
  const value = title.trim();
  if (!value) return '标题为空';
  if (/[\r\n【】]/u.test(value)) return '标题不能包含换行或【】分节';
  if (/建议/u.test(value)) return '标题不能包含建议说明';
  const length = itineraryDayTitleLength(value);
  if (length > budget) return `标题 ${length} 字，超过 ${budget} 字`;
  return undefined;
}
