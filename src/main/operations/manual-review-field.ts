/**
 * 运营手工复核阶段里把单个字段写入 product JSON 的工具。
 * 仅依赖 shared 契约，不引入 VBK 浏览器，保持纯函数特性便于测试。
 *
 * 支持的字段（用 `field` discriminator 拆分）：
 *  - pricing                  : commercial.pricing.adult / child / currency
 *  - basicInfoSubtitle        : basicInfo.subtitle
 *  - vehicleResource          : operations.vehicleResource.requestedDailyCost
 *  - butlerContact            : operations.bookingControls.butler（写入完整 ContactCardSelection；null 表示清空）
 *
 * 写入策略：
 *   - 数值字段：> 0（pricing.adult / requestedDailyCost）；
 *     pricing.child >= 0；requestedDailyCost > 0（可独立为 null）；
 *   - 文本字段：trim 后非空，> 1 字符（与 schema subtitle 同步）；
 *   - 真实资源组 ID / 名称只能由 VBK 匹配回填，手动复核入口不写。
 *   - 与 AI 写入路径完全解耦：product 走 schema 校验后才落库。
 */

import type { ContactCardSelection, ManualReviewFieldInput } from "../../shared/contracts.js";

/**
 * 防御式地把 unknown 转成 object 记录，遇到 null / 非对象 / 数组都返回空对象，
 * 用于后续展开时不需要再做 null 检查。
 */
function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/**
 * 把 input 中的合法字段覆盖到 product，返回新 product，调用方决定是否落库。
 *  - 任何子项校验失败立即抛错，不写一半；
 *  - 不修改原 product 的副本（structuredClone）。
 */
export function applyManualReviewField(product: Record<string, unknown>, input: ManualReviewFieldInput): Record<string, unknown> {
  switch (input.field) {
    case "pricing": return applyPricing(product, input.adult, input.child);
    case "basicInfoSubtitle": return applyBasicInfoSubtitle(product, input.subtitle);
    case "vehicleResource": return applyVehicleResource(product, input);
    case "butlerContact": return applyButlerContact(product, input.selection);
    default: {
      // 编译期已穷尽，运行期兜底
      const exhaustive: never = input;
      throw new Error(`不支持的 ManualReviewFieldInput：${(exhaustive as { field?: string }).field ?? "unknown"}`);
    }
  }
}

function applyPricing(product: Record<string, unknown>, adult: number, child: number): Record<string, unknown> {
  if (!Number.isFinite(adult) || adult <= 0) throw new Error("成人价必须大于 0。");
  if (!Number.isFinite(child) || child < 0) throw new Error("儿童价不能小于 0。");
  const next = structuredClone(product) as Record<string, unknown>;
  const commercial = objectValue(next.commercial);
  commercial.pricing = {
    ...objectValue(commercial.pricing),
    currency: "CNY",
    adult,
    child,
  };
  next.commercial = commercial;
  return next;
}

function applyBasicInfoSubtitle(product: Record<string, unknown>, subtitle: string): Record<string, unknown> {
  const trimmed = (subtitle ?? "").trim();
  // 与 schema 保持一致：subtitle 长度 2..80。
  if (trimmed.length < 2) throw new Error("副标题至少需要 2 个字符。");
  if (trimmed.length > 80) throw new Error("副标题不能超过 80 个字符。");
  const next = structuredClone(product) as Record<string, unknown>;
  const basicInfo = objectValue(next.basicInfo);
  basicInfo.subtitle = trimmed;
  next.basicInfo = basicInfo;
  return next;
}

function applyVehicleResource(
  product: Record<string, unknown>,
  input: Extract<ManualReviewFieldInput, { field: "vehicleResource" }>,
): Record<string, unknown> {
  const next = structuredClone(product) as Record<string, unknown>;
  const operations = objectValue(next.operations);
  const vehicle = { ...objectValue(operations.vehicleResource) };

  // 不存在的子项视为「不动」，null 表示清空 requestedDailyCost。
  if (input.requestedDailyCost !== undefined) {
    if (input.requestedDailyCost === null) {
      // 显式清空「AI 预估日价·待核查」：同时写一个 sentinel 字段，让下游
      // targetVehicleDailyCost 能区分「从未设置」与「被用户主动清除」，
      // 避免后续自动匹配继续使用已清空的 AI 建议价。
      delete vehicle.requestedDailyCost;
      vehicle.requestedDailyCostCleared = true;
    } else {
      if (!Number.isFinite(input.requestedDailyCost) || input.requestedDailyCost <= 0) {
        throw new Error("AI 预估日价必须大于 0，或传 null 清除。");
      }
      vehicle.requestedDailyCost = input.requestedDailyCost;
      // 重新设值时把上一次的清除标记也撤销，否则旧的「已清除」语义会污染
      // 新一轮的估算路径。
      delete vehicle.requestedDailyCostCleared;
    }
  }

  operations.vehicleResource = vehicle;
  next.operations = operations;
  return next;
}

function applyButlerContact(
  product: Record<string, unknown>,
  selection: ContactCardSelection | null,
): Record<string, unknown> {
  const next = structuredClone(product) as Record<string, unknown>;
  const operations = objectValue(next.operations);
  const bookingControls = objectValue(operations.bookingControls);

  if (selection === null) {
    delete bookingControls.butler;
  } else {
    if (!isContactCardSelection(selection)) {
      throw new Error("管家联系人必须包含合法的 contactCardId / providerId / displayName。");
    }
    bookingControls.butler = {
      contactCardId: selection.contactCardId,
      displayName: selection.displayName.trim(),
      providerId: selection.providerId,
    };
  }

  // 没有任何控件（advanceBooking / butler 都缺）时整个 bookingControls 也删掉，
  // 与其它 schema-optional 字段保持一致，不在 product 里堆积空对象。
  if (Object.keys(bookingControls).length === 0) {
    delete operations.bookingControls;
  } else {
    operations.bookingControls = bookingControls;
  }
  next.operations = operations;
  return next;
}

/**
 * 类型守卫：判断一个对象是否是合法的 ContactCardSelection。
 * - 三个字段都必须存在且类型正确；
 * - id / providerId 必须为正整数，displayName 必须为非空字符串。
 */
function isContactCardSelection(value: unknown): value is ContactCardSelection {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const id = candidate.contactCardId;
  const providerId = candidate.providerId;
  const name = typeof candidate.displayName === "string" ? candidate.displayName.trim() : "";
  return Number.isInteger(id) && (id as number) > 0
    && Number.isInteger(providerId) && (providerId as number) > 0
    && name.length > 0;
}
