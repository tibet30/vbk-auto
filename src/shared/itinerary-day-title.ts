// 天标题的长度预算与最终写入校验入口：统一 70 字上限，文法委托 day-title-grammar。
import { arrivalTitlePrefix } from './itinerary-arrival-title.js';
import { DAY_TITLE_MAX_NODES, dayTitleGrammarProblem, itineraryTitleLength, type DayTitleFacts } from './day-title-grammar.js';

/**
 * 天标题写入 VBK `dailyDescription`，平台对超长标题直接 Ack=Failure
 * （产品 ae3316d7：88/167 字被拒；已成功录入的最长 70 字）。上限按字符计数，
 * 首日会被追加「【出发地-城市】」前缀，生成侧必须为前缀预留预算。
 * 全部产品（含私家团）共用同一上限。
 */
export const ITINERARY_DAY_TITLE_MAX_LENGTH = 70;

export const ITINERARY_DAY_TITLE_FORMAT_GUIDE = `title 是一行中文天标题，格式为「起点-玩法-玩法(拓展)-住落点【含项说明】」，最多 ${ITINERARY_DAY_TITLE_MAX_LENGTH} 个字符（首日会追加「【出发地-城市】」前缀，需再预留约 10 字）：起点写当天出发地；每个「-」段写当天动线的一个动作（地点+玩法，如「雪岭徒步」「偶遇驯鹿」），整行最多 ${DAY_TITLE_MAX_NODES} 段；某段需要补充说明时在该段末尾紧跟半角括号（如「冰川夜钓(手摇网红小呲花)」），括号内容只能解释紧邻的前一个点位本身（如「帕拉庄园(配讲解)」），不得把别的景点名塞进括号；optionalNames 不必全部写入，标题是动线摘要不是景点清单；当天有住宿才写「-住落点」；当天原文有门票、景交等服务含项才在末尾写「【含项说明】」。不得使用换行、emoji、+、→、/、冒号、逗号或空格；玩法节点不得写营销词或建议说明（括号拓展除外）。`;

export function itineraryDayTitleLength(title: string): number {
  return itineraryTitleLength(title);
}

export function itineraryDayTitleBudget(product: Record<string, unknown>, day: number): number {
  const prefix = day === 1 ? arrivalTitlePrefix(product) : '';
  return ITINERARY_DAY_TITLE_MAX_LENGTH - [...prefix].length;
}

export function itineraryDayTitleProblem(title: string, budget: number, facts?: DayTitleFacts): string | undefined {
  return dayTitleGrammarProblem(title, budget, facts);
}
