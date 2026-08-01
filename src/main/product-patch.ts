import { parseProduct } from "./automation/schema.js";
import { normaliseProductDraft } from "./product-normalize.js";
import type { AiResponse } from "../shared/contracts.js";

export function applyProductPatch(product: Record<string, unknown>, patch: NonNullable<AiResponse["patch"]>) {
  const result = structuredClone(product) as Record<string, unknown>;
  for (const operation of patch) {
    const segments = operation.path.split("/").slice(1).map(decodeURIComponent);
    if (!segments.length || segments.some((segment) => segment === "__proto__" || segment === "constructor")) throw new Error("产品变更路径不安全");
    let parent: Record<string, unknown> | unknown[] = result;
    for (const segment of segments.slice(0, -1)) {
      const key = Array.isArray(parent) ? Number(segment) : segment;
      const current = parent[key as never];
      if (!current || typeof current !== "object") {
        if (operation.op === "remove") throw new Error(`产品字段不存在：${operation.path}`);
        parent[key as never] = {} as never;
      }
      parent = parent[key as never] as Record<string, unknown> | unknown[];
    }
    const last = Array.isArray(parent) ? Number(segments.at(-1)) : segments.at(-1)!;
    if (operation.op === "remove") {
      if (Array.isArray(parent)) parent.splice(last as number, 1); else delete parent[last as string];
    } else parent[last as never] = operation.value as never;
  }
  const normalised = normaliseProductDraft(result);
  // A partial planning draft is intentionally allowed. Full Zod validation only
  // gates automation, avoiding a false impression that an incomplete plan is ready.
  try { parseProduct(normalised); } catch { /* Stored as draft until all blocking fields resolve. */ }
  return normalised;
}
