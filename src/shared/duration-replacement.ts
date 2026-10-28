import type { ProductDetail } from "./contracts.js";

/**
 * 改天数被 VBK 拒绝时「保留旧草稿、新建产品重录」的显式授权范围。
 * 只有运营确认的批准里包含它，录入流程才允许解绑旧草稿并新建产品。
 */
export const DURATION_REPLACEMENT_SCOPE = "vbk.duration_replacement";

/**
 * 当前绑定远端草稿上最后一次录入的行程天数：取自每日行程阶段完成（远端回读通过）
 * 时记录的 AutomationRun.enteredItineraryDays。没有记录时返回 undefined（未知）。
 */
export function enteredRemoteItineraryDays(product: Pick<ProductDetail, "automation">): number | undefined {
  const days = product.automation?.enteredItineraryDays;
  return Number.isInteger(days) && days! > 0 ? days : undefined;
}

/** 已绑定远端草稿，且本地 basicInfo.days 与最后一次录入的行程天数不同。未知时按未变化处理。 */
export function durationChangedFromRemote(product: Pick<ProductDetail, "productId" | "product" | "automation">): boolean {
  if (!product.productId) return false;
  const entered = enteredRemoteItineraryDays(product);
  const basic = product.product?.basicInfo as Record<string, unknown> | undefined;
  const days = Number(basic?.days);
  return entered !== undefined && Number.isInteger(days) && days > 0 && days !== entered;
}

/**
 * 确认卡说明补全：范围含 vbk.duration_replacement 时，运营看到的说明必须包含
 * 旧草稿 ID 与「新建产品」提示；已包含则不重复追加。范围不含时原样返回。
 */
export function withDurationReplacementNotice(
  summary: string, scope: readonly string[], product: Pick<ProductDetail, "productId" | "product" | "automation"> | undefined,
): string {
  if (!scope.includes(DURATION_REPLACEMENT_SCOPE) || !product) return summary;
  const notice = durationReplacementNotice(product);
  if (!notice || summary.includes(notice)) return summary;
  return `${summary.trim()}${summary.trim() ? "\n" : ""}${notice}`;
}

export function durationReplacementNotice(product: Pick<ProductDetail, "productId" | "product" | "automation">): string {
  return durationChangedFromRemote(product)
    ? `若 VBK 拒绝改天数，将保留旧草稿 ${product.productId} 并新建产品重新录入。`
    : "";
}
