/**
 * operations.bookingControls.butler 字段写入：
 *   - applyButlerContact：selection === null 时清空；非 null 时校验
 *     ContactCardSelection（contactCardId / providerId 正整数、displayName
 *     非空）并写入；bookingControls 若整段为空则同步删除，避免 product
 *     里堆积空对象；
 *   - isContactCardSelection：类型守卫。
 */

import type { ContactCardSelection, ManualReviewFieldInput } from "../../../shared/contracts.js";
import { objectValue } from "./util.js";

export function applyButlerContact(
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
export function isContactCardSelection(value: unknown): value is ContactCardSelection {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const id = candidate.contactCardId;
  const providerId = candidate.providerId;
  const name = typeof candidate.displayName === "string" ? candidate.displayName.trim() : "";
  return Number.isInteger(id) && (id as number) > 0
    && Number.isInteger(providerId) && (providerId as number) > 0
    && name.length > 0;
}

export type { ContactCardSelection, ManualReviewFieldInput };