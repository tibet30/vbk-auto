/**
 * 携程 / VBK suggestPoi 抓取与结果契约：
 *   - 日志上下文把「这一段对话」和「这个 spot」打通；
 *   - 结果结构逐层收敛：PoiSuggestTextField（仅文本）→ PoiSuggestCandidate
 *     （含 selectability）→ PoiSuggestDetailResult（含 httpStatus）。
 *
 * 单独成模块是因为 main 端 PoiSuggestContextHelper 抓取逻辑和
 * renderer 端的「候选可点 / 不可点」判断都依赖它。
 */

export interface PoiSuggestLogContext {
  localProductId: string;
  dayIndex: number;
  spotIndex: number;
  title: string;
  destinationCity?: string;
  province?: string;
}

export interface PoiSuggestion {
  poiName: string;
  poiId: number;
}

export interface PoiSuggestTextField {
  path: string;
  value: string;
}

export interface PoiSuggestCandidate {
  index: number;
  poiName: string | null;
  poiId: number | null;
  province?: string | null;
  city?: string | null;
  district?: string | null;
  address?: string | null;
  selectable: boolean;
  textFields: PoiSuggestTextField[];
}

export interface PoiSuggestDetailResult {
  httpStatus: number;
  businessStatus: string | number | boolean | null;
  poiListCount: number;
  best: PoiSuggestion | null;
  candidates: PoiSuggestCandidate[];
}