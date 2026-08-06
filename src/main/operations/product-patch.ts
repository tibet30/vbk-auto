import { parseProduct } from "../automation/schema/schema.js";
import { normaliseProductDraft } from "../data/product-normalize.js";
import type { AiResponse } from "../../shared/contracts.js";

type PatchOperation = NonNullable<AiResponse["patch"]>[number];

// RFC6902 的数组语义：add 是插入（"-" 表示追加），replace 是就地替换，
// remove 是删除；下标越界一律拒绝，避免把模型的错误路径写成脏数据。
function applyArrayOperation(target: unknown[], token: string, operation: PatchOperation) {
  if (operation.op === "add" && token === "-") {
    target.push(operation.value);
    return;
  }
  if (!/^\d+$/.test(token)) throw new Error(`行程下标不合法：${operation.path}`);
  const index = Number(token);
  const limit = operation.op === "add" ? target.length : target.length - 1;
  if (index > limit) throw new Error(`行程下标超出范围：${operation.path}`);
  if (operation.op === "add") target.splice(index, 0, operation.value);
  else if (operation.op === "remove") target.splice(index, 1);
  else target[index] = operation.value;
}

export function applyProductPatch(product: Record<string, unknown>, patch: NonNullable<AiResponse["patch"]>) {
  const result = structuredClone(product) as Record<string, unknown>;
  for (const operation of patch) {
    // add/replace 缺少 value 时会写入 undefined，落库时被 JSON.stringify 整段丢弃，
    // 等于一次格式不规范的模型回复静默删掉已经写好的内容。
    if (operation.op !== "remove" && !("value" in operation)) {
      throw new Error(`产品变更缺少 value：${operation.path}`);
    }
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
    const token = segments.at(-1)!;
    if (Array.isArray(parent)) {
      applyArrayOperation(parent, token, operation);
    } else if (operation.op === "remove") {
      delete parent[token];
    } else {
      parent[token] = operation.value;
    }
  }
  const normalised = normaliseProductDraft(result);
  // A partial planning draft is intentionally allowed. Full Zod validation only
  // gates automation, avoiding a false impression that an incomplete plan is ready.
  try { parseProduct(normalised); } catch { /* Stored as draft until all blocking fields resolve. */ }
  return normalised;
}
