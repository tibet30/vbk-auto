import type { ManualReviewFieldInput } from "../../shared/contracts.js";

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function applyManualReviewField(product: Record<string, unknown>, input: ManualReviewFieldInput) {
  const next = structuredClone(product) as Record<string, unknown>;
  if (!Number.isFinite(input.adult) || input.adult <= 0) throw new Error("成人价必须大于 0。");
  if (!Number.isFinite(input.child) || input.child < 0) throw new Error("儿童价不能小于 0。");
  const commercial = objectValue(next.commercial);
  commercial.pricing = {
    ...objectValue(commercial.pricing),
    currency: "CNY",
    adult: input.adult,
    child: input.child,
  };
  next.commercial = commercial;
  return next;
}
