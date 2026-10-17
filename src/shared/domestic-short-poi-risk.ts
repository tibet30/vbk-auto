import type { AgentInputRequest, AgentQuestion } from "./contracts-agent.js";

const RISK_PATTERN = /数据风险[\s\S]*?(?:POI|途径地)[：:]\s*([^，,；;。]+?)\s*且\s*产品类型[：:]\s*境内短途旅游/u;
export const DOMESTIC_SHORT_POI_RISK_QUESTION_PREFIX = "domestic-short-poi-risk:";
export const DOMESTIC_SHORT_POI_REMOVE_OPTION = "remove-risk-poi";
export const DOMESTIC_SHORT_POI_KEEP_OPTION = "keep-risk-poi";

export function domesticShortPoiRiskName(message: string): string | undefined {
  return RISK_PATTERN.exec(message)?.[1]?.trim() || undefined;
}

export function domesticShortPoiRiskQuestion(message: string): AgentQuestion | undefined {
  const poiName = domesticShortPoiRiskName(message);
  if (!poiName) return undefined;
  return {
    id: `${DOMESTIC_SHORT_POI_RISK_QUESTION_PREFIX}${encodeURIComponent(poiName)}`,
    label: `VBK 不接受结构化 POI「${poiName}」与“境内短途旅游”的组合。确认后，系统会从行程各天剔除所有绑定为「${poiName}」的条目，并保留人工删除记录；方案变化后需重新确认录入。`,
    kind: "single",
    required: true,
    options: [
      { id: DOMESTIC_SHORT_POI_REMOVE_OPTION, label: `确认剔除「${poiName}」并重新核对方案` },
      { id: DOMESTIC_SHORT_POI_KEEP_OPTION, label: "暂不剔除，停止自动录入" },
    ],
  };
}

export function domesticShortPoiRiskInput(message: string, requestId: string): AgentInputRequest | undefined {
  const question = domesticShortPoiRiskQuestion(message);
  if (!question) return undefined;
  return { id: requestId, questions: [question], createdAt: new Date().toISOString() };
}

export function domesticShortPoiRiskQuestionName(id: string): string | undefined {
  if (!id.startsWith(DOMESTIC_SHORT_POI_RISK_QUESTION_PREFIX)) return undefined;
  try {
    return decodeURIComponent(id.slice(DOMESTIC_SHORT_POI_RISK_QUESTION_PREFIX.length)).trim() || undefined;
  } catch {
    return undefined;
  }
}

export function domesticShortPoiRiskDecision(
  request: AgentInputRequest,
  answers: Record<string, string | string[]>,
): { action: "remove" | "keep"; poiName: string } | undefined {
  const question = request.questions.find((item) => domesticShortPoiRiskQuestionName(item.id));
  if (!question) return undefined;
  const poiName = domesticShortPoiRiskQuestionName(question.id)!;
  const answer = answers[question.id];
  const selected = Array.isArray(answer) ? answer[0] : answer;
  if (selected === DOMESTIC_SHORT_POI_REMOVE_OPTION) return { action: "remove", poiName };
  if (selected === DOMESTIC_SHORT_POI_KEEP_OPTION) return { action: "keep", poiName };
  return undefined;
}

export function isDomesticShortPoiRiskQuestionId(id: string): boolean {
  return Boolean(domesticShortPoiRiskQuestionName(id));
}
