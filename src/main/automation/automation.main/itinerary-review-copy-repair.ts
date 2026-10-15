/**
 * 行程审核校验被平台以「非法关键词」驳回时的自动修复闭环：
 *
 *   命中路径定位 → AI 定点改写 → 落库 → 重存行程草稿（saveType=2，把修正后的
 *   文案推到远端草稿）→ 重新提交审核（saveType=8/3）。
 *
 * 只在「平台驳回只读校验、本次提交没有派发任何远端写入」时触发；已经发生真实
 * 写入后的失败仍然走 uncertain 人工核对门禁，不放宽既有安全边界。
 * 修复预算有上限，用尽后按普通阶段失败上抛，不伪造成功。
 */
import type { AutomationRunContext } from "./automation.main.context.js";
import { extractSensitiveWords } from "../../../shared/sensitive-words.js";
import { findSensitiveItineraryPaths, type ItineraryCopyProduct } from "./itinerary-copy-paths.js";
import { applySensitiveItineraryRewrite, itineraryRewriteRequest } from "./itinerary-sensitive-rewrite.js";

export const ITINERARY_REVIEW_COPY_REPAIR_LIMIT = 2;

/** 只读校验阶段的驳回：远端没有接受任何写入，可修正文案后重试。 */
export function isValidationOnlyReviewFailure(error: unknown): boolean {
  return Boolean(error && typeof error === "object"
    && (error as { itineraryReviewValidationOnly?: boolean }).itineraryReviewValidationOnly === true);
}

export interface ItineraryReviewCopyRepairArgs<T> {
  ctx: AutomationRunContext;
  localProductId: string;
  product: ItineraryCopyProduct;
  log: (message: string, level?: "info" | "warning" | "error") => void;
  submitReview: () => Promise<T>;
  /** 重新走一次行程草稿保存，让远端草稿与本地修正后的文案一致。 */
  saveDraft: () => Promise<unknown>;
  /** 把改写后的产品落库（只改行程文案，不改方案选择）。 */
  persist: () => void;
  maxRepairs?: number;
}

function learn(args: ItineraryReviewCopyRepairArgs<unknown>, words: readonly string[], paths: readonly string[], detail: string): void {
  for (const word of words) {
    try {
      args.ctx.db.recordCopyFeedback({ word, module: "itinerary", paths: [...paths], source: "review-check", detail });
    } catch {
      /* 学习失败不影响本次修复。 */
    }
  }
}

async function repairCopy(
  args: ItineraryReviewCopyRepairArgs<unknown>,
  words: readonly string[],
  reason: string,
): Promise<void> {
  const rewriter = args.ctx.itineraryCopyRewriter;
  const paths = findSensitiveItineraryPaths(args.product, words);
  if (!paths.length) {
    throw new Error(`平台驳回了行程文案（${words.join("、")}），但未能在当前行程文案中定位命中字段。`);
  }
  if (!rewriter) {
    throw new Error(`平台驳回了行程文案（${words.join("、")}），但当前未配置行程文案改写器，无法自动修复。`);
  }
  args.log(`平台驳回行程文案“${words.join("、")}”，正在自动改写 ${paths.join("、")} 并重新保存行程草稿`, "warning");
  const response = await rewriter(itineraryRewriteRequest(args.product, words, paths));
  applySensitiveItineraryRewrite(args.product, response, words);
  learn(args, words, paths, reason.slice(0, 800));
  args.persist();
  await args.saveDraft();
  args.log(`行程文案已自动改写（${paths.join("、")}）并重新保存草稿，继续提交审核`, "warning");
}

/**
 * 提交行程审核；平台以非法关键词驳回只读校验时，先自动改写命中文案再重试。
 * 已学习到本地反馈表的词会在首次提交前预检改写，避免重复踩同一个词。
 */
export async function runItineraryReviewWithCopyRepair<T>(args: ItineraryReviewCopyRepairArgs<T>): Promise<T> {
  const maxRepairs = args.maxRepairs ?? ITINERARY_REVIEW_COPY_REPAIR_LIMIT;
  let repairs = 0;

  const known = args.ctx.db.listRejectedItineraryWords?.() ?? [];
  const preemptive = known.filter((word) => word && findSensitiveItineraryPaths(args.product, [word]).length);
  if (preemptive.length && repairs < maxRepairs) {
    await repairCopy(args, preemptive, `平台此前拒绝过的行程文案词：${preemptive.join("、")}`);
    repairs += 1;
  }

  for (;;) {
    try {
      return await args.submitReview();
    } catch (error) {
      if (!isValidationOnlyReviewFailure(error)) throw error;
      const message = error instanceof Error ? error.message : String(error);
      const words = extractSensitiveWords(message);
      if (!words.length) throw error;
      if (repairs >= maxRepairs) {
        args.log(`行程文案自动修复已使用 ${repairs}/${maxRepairs} 轮仍未通过平台校验：${message}`, "warning");
        throw error;
      }
      await repairCopy(args, words, message);
      repairs += 1;
    }
  }
}
