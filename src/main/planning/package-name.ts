import type { PlanningSkeleton } from "../../shared/contracts-planning.js";
import { PRODUCT_FORM_LABELS } from "../../shared/product-form.js";

export function buildPackageName(skeleton: PlanningSkeleton): string {
  const destination = skeleton.destination.trim() || "目的地";
  const formLabel = PRODUCT_FORM_LABELS[skeleton.productForm];
  return `${destination}${skeleton.days}天${skeleton.nights}晚${formLabel}`;
}

export function normalisePackageNameValue(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  const preferredKeys = ["packageName", "value", "name", "title"] as const;
  const hits = preferredKeys
    .filter((key) => typeof record[key] === "string" && record[key].trim().length > 0)
    .map((key) => ({ key, value: (record[key] as string).trim() }));
  if (hits.length === 0) return value;
  const uniqueValues = new Set(hits.map((hit) => hit.value));
  if (uniqueValues.size > 1) return value;
  const allowedMetadataKeys = new Set(["reason", "note", "notes", "description", "remark"]);
  const hitKeys = new Set<string>(hits.map((hit) => hit.key));
  const hasOnlySafeExtras = Object.entries(record).every(([key, child]) => (
    hitKeys.has(key)
    || allowedMetadataKeys.has(key)
    || child === null
    || child === undefined
  ));
  return hasOnlySafeExtras ? hits[0].value : value;
}
