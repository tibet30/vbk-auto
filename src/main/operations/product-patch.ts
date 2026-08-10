/**
 * 产品 JSON Patch 应用器：
 *   - AI 输出通过 RFC6902 patch 形式落到 product 对象；
 *   - 黑名单路径（supplierProductCode / 资源 ID / 联系人 ID 等）必须人工写入，
 *     applyPatchOperation 会拒绝写入；
 *   - applyProductPatch 是入口，applyProductPatchSafe 提供「单条失败不阻塞整批」的容错版。
 */

import { parseProduct } from "../automation/schema/schema.js";
import { normaliseProductDraft } from "../data/product-normalize.js";
import type { AiResponse } from "../../shared/contracts.js";

type PatchOperation = NonNullable<AiResponse["patch"]>[number];

/**
 * AI / patch 不得写入的路径前缀黑名单。supplierProductCode 与车辆 / 酒店资源
 * ID 是运营数据，必须由 VBK 或人工填充；当前接受者（applyProductPatch /
 * applyProductPatchSafe）会直接拒绝任何带这些前缀的 patch。
 */
const FORBIDDEN_PATH_PREFIXES = [
  "/basicInfo/supplierProductCode",
  "/operations/butler",
  "/operations/bookingControls",
  "/operations/hotelResource",
] as const;

const ALLOWED_VEHICLE_RESOURCE_PATHS = [
  "/operations/vehicleResource/requestedDailyCost",
] as const;

/**
 * 判断 path 是否命中黑名单前缀（精确命中或子路径都算）；用于阻断 AI 写运营 / 资源 ID 等关键字段。
 */
function isForbiddenPath(path: string): boolean {
  if (path === "/operations/vehicleResource" || path.startsWith("/operations/vehicleResource/")) {
    return !(ALLOWED_VEHICLE_RESOURCE_PATHS as readonly string[]).includes(path);
  }
  return FORBIDDEN_PATH_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

function assertAllowedVehicleResourceValue(operation: PatchOperation) {
  if (operation.path !== "/operations/vehicleResource/requestedDailyCost" || operation.op === "remove") return;
  if (operation.value === null) return;
  const value = Number(operation.value);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`AI 预估用车日价必须是正数：${operation.path}`);
  }
  operation.value = value;
}

// RFC6902 的数组语义：add 是插入（"-" 表示追加），replace 是就地替换，
// remove 是删除；下标越界一律拒绝，避免把模型的错误路径写成脏数据。
/**
 * RFC6902 数组语义的实现：
 *   - add + "-"：push；
 *   - 数字 token 校验为合法下标；
 *   - 越界一律抛错，避免写入脏数据。
 */
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

/**
 * 执行单个 RFC6902 patch operation：
 *   - 不允许 op != remove 但缺 value；
 *   - path 必须以 "/" 开头，禁止原型链污染（__proto__ / constructor）；
 *   - 黑名单路径拒绝；
 *   - 中间段按需创建空对象，最后一段做增 / 替 / 删。
 */
function applyPatchOperation(product: Record<string, unknown>, operation: PatchOperation) {
  // add/replace 缺少 value 时会写入 undefined，落库时被 JSON.stringify 整段丢弃，
  // 等于一次格式不规范的模型回复静默删掉已经写好的内容。
  if (operation.op !== "remove" && !("value" in operation)) {
    throw new Error(`产品变更缺少 value：${operation.path}`);
  }

  // RFC6902 要求 path 必须以 "/" 开头；不以 "/" 开头会被 split 后的 slice(1) 误吞首段，
  // 导致 "__proto__/bad" 这种危险路径变成只检测最后一段，整段污染原型链。
  if (!operation.path.startsWith("/")) {
    throw new Error(`产品变更路径不合法：${operation.path}`);
  }
  // 黑名单路径：supplierProductCode / 资源 ID / 联系人卡 ID 都是运营数据，
  // 必须由 VBK 或人工填充；AI 写入一律拒绝。
  if (isForbiddenPath(operation.path)) {
    throw new Error(`产品变更路径被禁写：${operation.path}`);
  }
  assertAllowedVehicleResourceValue(operation);
  const segments = operation.path.split("/").slice(1).map(decodeURIComponent);
  if (!segments.length || segments.some((segment) => segment === "__proto__" || segment === "constructor")) {
    throw new Error("产品变更路径不安全");
  }

  let parent: Record<string, unknown> | unknown[] = product;
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
    return;
  }

  if (operation.op === "remove") {
    delete parent[token];
    return;
  }

  parent[token] = operation.value;
}

/**
 * 顺序执行一批 patch；调用方需要先 structuredClone，本函数会就地修改入参。
 * 任何 operation 抛错都会冒泡，由 applyProductPatchSafe / applyProductPatch 选择处理策略。
 */
function applyPatchMutably(product: Record<string, unknown>, patch: PatchOperation[]) {
  for (const operation of patch) {
    applyPatchOperation(product, operation);
  }
}

/**
 * AI / patch 入口：调用 normaliseProductDraft 时必须显式传 safeRelease:true，
 * 确保 AI 即便写 release.submitReview=true / publishAfterApproval=true 也会被
 * 强制为 draft-only（false）。不传这个选项会把已经人工 / VBK 打开的发布态
 * 默默清零——这是历史发布标记的破坏性 bug，禁止默认开启。
 */
const AI_PATCH_NORMALISE_OPTIONS = { safeRelease: true } as const;

export function applyProductPatch(product: Record<string, unknown>, patch: NonNullable<AiResponse["patch"]>) {
  const result = structuredClone(product) as Record<string, unknown>;
  applyPatchMutably(result, patch);
  const normalised = normaliseProductDraft(result, AI_PATCH_NORMALISE_OPTIONS);
  // A partial planning draft is intentionally allowed. Full Zod validation only
  // gates automation, avoiding a false impression that an incomplete plan is ready.
  try { parseProduct(normalised); } catch { /* Stored as draft until all blocking fields resolve. */ }
  return normalised;
}

export type ProductPatchSafeResult = {
  product: Record<string, unknown>;
  applied: boolean;
};

export function applyProductPatchSafe(
  product: Record<string, unknown>,
  patch: NonNullable<AiResponse["patch"]>,
): ProductPatchSafeResult {
  if (!patch.length) return { product, applied: false };
  let result = structuredClone(product) as Record<string, unknown>;
  let applied = false;

  for (const operation of patch) {
    try {
      const next = structuredClone(result) as Record<string, unknown>;
      applyPatchOperation(next, operation);
      result = next;
      applied = true;
    } catch (error) {
      console.warn("[AI] patch operation skipped", {
        op: operation.op,
        path: operation.path,
        reason: error instanceof Error ? error.message : "unknown",
      });
    }
  }

  if (!applied) return { product, applied: false };
  const normalised = normaliseProductDraft(result, AI_PATCH_NORMALISE_OPTIONS);
  try { parseProduct(normalised); } catch { /* Stored as draft until all blocking fields resolve. */ }
  return { product: normalised, applied: true };
}
