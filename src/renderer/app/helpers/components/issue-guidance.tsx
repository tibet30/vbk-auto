/**
 * 把后端直发的技术校验文本映射为运营可直接执行的中文提示；保留有意义的
 * 非技术描述（如 "建议补充图片"、"需与供应商二次确认"）。输入里出现
 * "Invalid input"、"expected ... received"、"undefined"/"null" 等
 * Zod/JSON 风格的内部错误信息时一律替换。
 */

export const issueGuidance: Record<string, string> = {
  "basicInfo.supplierProductCode": "请补充供应商产品编码",
  "basicInfo.subtitle": "请填写一句产品副标题",
  "basicInfo.operationNotes": "请补充运营说明",
};

export const technicalDetailPattern = /(invalid input|expected .* received|undefined|null|required|received undefined|received null|invalid_type|invalid_string)/i;

export function formatIssueGuidance(issue: { label: string; detail: string }) {
  const mapped = issueGuidance[issue.label];
  if (mapped) return { guidance: mapped, isTechnical: false };
  const detail = (issue.detail || "").trim();
  if (!detail || technicalDetailPattern.test(detail)) {
    return { guidance: "请在右侧核查后补齐该项内容", isTechnical: true };
  }
  return { guidance: detail, isTechnical: false };
}