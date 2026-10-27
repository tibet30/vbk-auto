/**
 * POI 核验失败的对外说明。
 *
 * 失败原因必须区分三类，否则运营会被引向错误操作：
 *   - identity_mismatch：平台没有同名地点，候选都是其他景点或上下级景点；
 *     改当天城市没有用，应改名、手动选择或删除该景点；
 *   - location_mismatch：确实找到了同名候选，但地域与当天原路线不符；
 *   - no_candidate / ambiguous / queryFailed / suspended：查询侧事实。
 *
 * `isGeneratedPoiFailureDetail` 与生成文案共用同一组标记：已保存的有效 POI
 * 映射确认后，历史失败说明要被修回“已保存”，但不能覆盖运营手写的备注。
 */

export type PoiSelectionReason = "no_candidate" | "identity_mismatch" | "location_mismatch" | "ambiguous";

export interface PoiResearchFailureArgs {
  reason?: PoiSelectionReason;
  reviewingComplete: boolean;
  queryFailed: boolean;
  invalidLocation: boolean;
  invalidIdentity: boolean;
  suspended: boolean;
  travelNode: boolean;
}

export const SAVED_POI_DETAIL = "当前行程已保存有效的 VBK POI 映射。";

const CLEARED_IDENTITY_DETAIL = "本轮 POI 核验未完成：已清除与原景点身份或主子层级不符的旧 POI 绑定；请重新核验原地点，不能以其他景点或上下级景点代替。";
const QUERY_FAILED_DETAIL = "本轮 POI 核验未完成：平台查询失败或超时，已保留先前绑定；请重新查询并确认当前 POI";
const RETAINED_AMBIGUOUS_DETAIL = "本轮 POI 核验未完成：当前查询召回多个候选，无法安全确定唯一地点，已保留先前绑定；请重新查询或手动选择 POI";
const RETAINED_IDENTITY_DETAIL = "本轮 POI 核验未完成：当前查询只召回其他景点或上下级景点，已保留先前绑定；请重新查询并确认当前 POI";
const RETAINED_LOCATION_DETAIL = "本轮 POI 核验未完成：候选地域信息不足或与当前行程上下文不一致，已保留先前绑定；请重新查询并确认当前 POI";
const RETAINED_NO_CANDIDATE_DETAIL = "本轮 POI 核验未完成：当前查询未召回可确认候选，已保留先前绑定；请重新查询或手动确认当前 POI";
const SUSPENDED_DETAIL = "携程景点详情标记为暂停营业，不能加入行程；请替换为正常营业景点";
const TRAVEL_NODE_DETAIL = "该名称是接送/交通/住宿节点，不能作为行程景点 POI；请替换为可游览景点";
const IDENTITY_MISMATCH_DETAIL = "未找到与该景点一致、且不是其他景点或上下级景点的 VBK POI；请确认景点名称（可尝试简称），或手动绑定/删除该景点";
const LOCATION_MISMATCH_DETAIL = "已找到同名候选 POI，但其地域与当天原路线不一致；请确认当天行程地点范围或手动绑定 POI";
const AMBIGUOUS_DETAIL = "已找到多个候选 POI，但程序无法安全确定唯一地点；请手动选择 POI";
const NO_CANDIDATE_DETAIL = "未找到对应的 VBK POI，已保留原景点和原行程位置；请确认景点名称或手动录入 POI";

export function poiResearchFailureDetail(args: PoiResearchFailureArgs): string {
  if (args.invalidIdentity) return CLEARED_IDENTITY_DETAIL;
  const retained = args.reviewingComplete && !args.invalidLocation && !args.suspended;
  if (retained) {
    if (args.queryFailed) return QUERY_FAILED_DETAIL;
    if (args.reason === "ambiguous") return RETAINED_AMBIGUOUS_DETAIL;
    if (args.reason === "identity_mismatch") return RETAINED_IDENTITY_DETAIL;
    if (args.reason === "location_mismatch") return RETAINED_LOCATION_DETAIL;
    return RETAINED_NO_CANDIDATE_DETAIL;
  }
  if (args.suspended) return SUSPENDED_DETAIL;
  if (args.travelNode) return TRAVEL_NODE_DETAIL;
  if (args.reason === "identity_mismatch") return IDENTITY_MISMATCH_DETAIL;
  if (args.reason === "location_mismatch") return LOCATION_MISMATCH_DETAIL;
  if (args.reason === "ambiguous") return AMBIGUOUS_DETAIL;
  return NO_CANDIDATE_DETAIL;
}

/** 系统生成的 POI 失败说明标记；运营手写备注不在此列。 */
const GENERATED_POI_FAILURE_MARKERS = [
  "已清除与原景点身份",
  "本轮 POI 核验未完成",
  "携程景点详情标记为暂停营业",
  "不能作为行程景点 POI",
  "未找到与该景点一致",
  "未找到对应的 VBK POI",
  // 历史上「产品主城市」的旧文案仍要能被识别并修回。
  "已找到候选 POI",
  "已找到多个候选 POI",
  "已找到同名候选 POI",
] as const;

export function isGeneratedPoiFailureDetail(detail: string | null | undefined): boolean {
  const text = (detail ?? "").trim();
  return Boolean(text) && GENERATED_POI_FAILURE_MARKERS.some((marker) => text.includes(marker));
}
