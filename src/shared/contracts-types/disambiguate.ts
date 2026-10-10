/**
 * AI 歧义消除：在 VBK 下拉里选不到精确项时，把候选项列表发给 AI（默认 MiniMax，
 * 设置里可切换到 Evolink），让它选一个最像的（或者明确表示「无匹配」）。用在
 * 景区、景点、城市、车站等所有严格选择场景下。
 */

export interface DisambiguateRequest {
  /** 上下文类别 — 用在不同 prompt 约束。 */
  kind: "province" | "city" | "spot" | "station";
  /** 仅 kind=station 使用：区分本次候选来自机场框还是火车站框。 */
  stationSubtype?: "airport" | "train";
  /** 产品 JSON 中期望选中的原始值（可能是"太原""云冈石窟"这种）。 */
  desired: string;
  /** 产品完整 JSON，供 AI 理解上下文。 */
  product: Record<string, unknown>;
  /** VBK 下拉返回的全部候选（包含中文 / ID / 中文别名）。 */
  candidates: Array<{ id?: string; text: string }>;
}

export interface DisambiguateOutcome {
  /** 选中的候选项 text，未选中返回 null。 */
  pickedText: string | null;
  /** 模型对本次选择的置信度，范围为 0 到 1。 */
  confidence: number;
  /** AI 的判断理由（给人看）。 */
  reasoning: string;
}