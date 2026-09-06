export interface PoiUsabilityOption {
  name: string;
  usable: boolean;
  reason?: string;
  poiId?: number;
}

export type PoiUsabilityDecision =
  | { kind: "auto"; option: PoiUsabilityOption }
  | { kind: "choose"; options: PoiUsabilityOption[] }
  | { kind: "ask"; summary: string; options: PoiUsabilityOption[] };

/** 先滤可用性：1 个自动采用，多个留给用户选，0 个说明原因并征求意见。 */
export function chooseUsablePoiOptions(options: PoiUsabilityOption[]): PoiUsabilityDecision {
  const usable = options.filter((option) => option.usable);
  if (usable.length === 1) return { kind: "auto", option: usable[0]! };
  if (usable.length > 1) return { kind: "choose", options: usable };
  const details = options.map((option) => {
    const reason = option.reason?.trim() || "不可用";
    return `「${option.name}」${reason}`;
  });
  return {
    kind: "ask",
    options,
    summary: details.length
      ? `候选地点均不可用：${details.join("；")}。请补充可替换的地点，或其他安排意见。`
      : "候选地点均不可用。请补充可替换的地点，或其他安排意见。",
  };
}
