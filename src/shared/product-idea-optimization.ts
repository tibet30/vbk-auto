import type { ProductIdeaOptimizationReceipt } from "./contracts-types/product.js";

/**
 * 解析硬约束（逐日顺序、二选一、编号路线）时使用的用户想法。
 *
 * 采用 AI 优化稿后 userIdea 是优化稿，其中的「（建议：…如A或B）」、
 * 【服务建议】【二选一待定】等段落只是推荐，不是用户点名的约束；把它们当
 * 原文解析会锁出「如万州大瀑布 或 西山公园」这类必须同时保留的假二选一，
 * 规划永远无法通过。优化稿仍作为规划提示传给 AI，硬约束只认用户原文。
 */
export function constraintUserIdea(basicInfo: unknown): string {
  const basic = basicInfo && typeof basicInfo === "object" && !Array.isArray(basicInfo)
    ? basicInfo as Record<string, unknown> : {};
  const userIdea = typeof basic.userIdea === "string" ? basic.userIdea.trim() : "";
  const receipt = basic.ideaOptimization;
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return userIdea;
  const { optimizedIdea, originalIdea } = receipt as Record<string, unknown>;
  // 只有当前 userIdea 仍是这份优化稿时，原文才是它的来源；用户之后手改过就以现文为准。
  return typeof optimizedIdea === "string" && optimizedIdea.trim() === userIdea
    && typeof originalIdea === "string" && originalIdea.trim() ? originalIdea.trim() : userIdea;
}

export function normaliseIdeaOptimizationReceipt(
  value: unknown,
  activeIdea: string,
): ProductIdeaOptimizationReceipt | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("AI 优化记录格式无效。");
  }
  const row = value as Record<string, unknown>;
  const receipt: ProductIdeaOptimizationReceipt = {
    optimizedIdea: requiredText(row.optimizedIdea, 1000, "AI 优化稿"),
    originalIdea: requiredText(row.originalIdea, 1000, "原始想法"),
    preservedItems: textList(row.preservedItems, 20, 160),
    changes: changeList(row.changes),
    recommendations: textList(row.recommendations, 20, 160),
    warnings: textList(row.warnings, 20, 160),
    sourceFingerprint: requiredText(row.sourceFingerprint, 64, "输入指纹"),
    provider: requiredText(row.provider, 80, "AI 提供商"),
    model: requiredText(row.model, 160, "AI 模型"),
    optimizedAt: requiredText(row.optimizedAt, 60, "优化时间"),
  };
  if (!/^[a-f0-9]{64}$/.test(receipt.sourceFingerprint)) throw new Error("AI 优化记录的输入指纹无效。");
  if (Number.isNaN(Date.parse(receipt.optimizedAt))) throw new Error("AI 优化记录的时间无效。");
  if (receipt.optimizedIdea !== activeIdea.trim()) throw new Error("AI 版本与当前用户想法不一致。");
  return receipt;
}

function requiredText(value: unknown, limit: number, label: string): string {
  const result = typeof value === "string" ? value.trim() : "";
  if (!result || result.length > limit) throw new Error(`${label}格式无效。`);
  return result;
}

function textList(value: unknown, count: number, length: number): string[] {
  if (!Array.isArray(value) || value.length > count) throw new Error("AI 优化记录列表格式无效。");
  return value.map((item) => requiredText(item, length, "AI 优化记录条目"));
}

function changeList(value: unknown): ProductIdeaOptimizationReceipt["changes"] {
  if (!Array.isArray(value) || value.length > 20) throw new Error("AI 优化变化记录格式无效。");
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("AI 优化变化记录格式无效。");
    const row = item as Record<string, unknown>;
    return {
      before: requiredText(row.before, 240, "调整前内容"),
      after: requiredText(row.after, 240, "调整后内容"),
      reason: requiredText(row.reason, 160, "调整原因"),
    };
  });
}
