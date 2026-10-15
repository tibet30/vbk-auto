/**
 * 「行程审核」是 VBK 产品向导的一个解锁边界，不是「行程描述」页内的动作。
 *
 * 主进程 `isItineraryReviewCompletedMenus`（src/main/automation/ctrip/
 * product-menu-readback.ts）规定：maxStep=10 时菜单前 5 项
 * （销售控制 / 产品信息 / 产品图文 / 行程描述 / 套餐管理）全部可用，
 * 其余页签保持锁定、靠各自模块保存逐个解锁。
 *
 * 因此这里只在「自动录入进度」列表底部说明边界整体状态，
 * 不再把入口挂在「行程描述」行下方。改动本文件时必须同步上面那份规则。
 */

import type { ItineraryReviewUnlockState } from "../../../../../shared/itinerary-review-unlock";

/** 一次行程审核解锁的页签数量，对应 menu-readback 的 index < 5 判定。 */
export const ITINERARY_REVIEW_UNLOCKED_MENU_COUNT = 5;

/** 一次行程审核覆盖的解锁范围，用于文案。 */
const BOUNDARY_LABEL = "销售控制 → 套餐管理";

/** 尚未取得任何核查结果时的静态说明，与录入授权语义保持一致。 */
export const ITINERARY_REVIEW_IDLE_NOTE = "录入授权后自动保存产品、审核行程并解锁标签；产品保持未发布。";

export interface ItineraryReviewBoundary {
  tone: "idle" | "verified" | "attention" | "error";
  /** 列表底部的边界说明行文案，任何状态下都会展示。 */
  note: string;
  /** 仅在异常态为 true：此时才追加只读核查入口，正常态零占位。 */
  needsAttention: boolean;
}

function lockedTitles(state: ItineraryReviewUnlockState | null): string[] {
  const menus = state?.receipt?.menus;
  if (!Array.isArray(menus)) return [];
  return menus.filter(menu => menu.enabled === "F").map(menu => menu.title || menu.key).filter(Boolean);
}

function verifiedNote(state: ItineraryReviewUnlockState): string {
  const receipt = state.receipt;
  const unlocked = receipt?.tabs.length ?? 0;
  const locked = lockedTitles(state);
  if (!receipt) return `行程审核已完成，${BOUNDARY_LABEL} 及前置页签均已解锁。`;
  const total = unlocked + locked.length;
  const scope = `已解锁 ${unlocked}/${total} 个页签，覆盖 ${BOUNDARY_LABEL}`;
  if (locked.length === 0) return `行程审核已完成，${scope}，全部可用。`;
  return `行程审核已完成，${scope}；待解锁 ${locked.join("、")}，随各模块保存逐个开放。`;
}

/**
 * 把持久化的行程审核状态映射为一条边界说明；异常态额外要求核查入口。
 * 文案只描述本地位图与远端回读结论，不承诺发布或交通子产品。
 */
export function describeItineraryReviewBoundary(
  state: ItineraryReviewUnlockState | null | undefined,
): ItineraryReviewBoundary {
  if (state?.digestMismatch) {
    return { tone: "error", note: state.message ?? "审核校验摘要与提交前不一致，只能只读核查。", needsAttention: true };
  }
  if (!state) return { tone: "idle", note: ITINERARY_REVIEW_IDLE_NOTE, needsAttention: false };
  if (state.status === "verified") return { tone: "verified", note: verifiedNote(state), needsAttention: false };
  if (state.status === "requires_review") {
    return {
      tone: "idle",
      note: `当前停在行程审核边界：审核完成后解锁 ${BOUNDARY_LABEL} 共 ${ITINERARY_REVIEW_UNLOCKED_MENU_COUNT} 个页签，其余随各模块保存逐个开放。`,
      needsAttention: false,
    };
  }
  if (state.status === "dispatched") {
    return { tone: "attention", note: state.message ?? "行程审核已提交，正在等待远端解锁结果。", needsAttention: true };
  }
  if (state.status === "uncertain") {
    return { tone: "attention", note: state.message ?? "审核结果尚待核实，可检查标签状态。", needsAttention: true };
  }
  return { tone: "error", note: state.message ?? "自动审核未完成，可检查标签状态。", needsAttention: true };
}
