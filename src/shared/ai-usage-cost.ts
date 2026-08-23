/**
 * AI Token → 人民币估算（刊例价，仅供桌面参考展示，非账单）。
 *
 * MiniMax：platform.minimaxi.com 按量计费（标准档，≤512k，永久五折口径）。
 * Evolink：官方 USD 标价 × 固定汇率 7.2 折算为元。
 */

export interface AiTokenRateCny {
  /** 元 / 百万 input tokens（未命中缓存） */
  inputPerMillion: number;
  /** 元 / 百万 output tokens */
  outputPerMillion: number;
  /** 元 / 百万 cached / cache-read tokens；缺省按 input 计 */
  cachedPerMillion?: number;
}

/** Evolink USD → CNY 固定汇率（展示用近似值）。 */
export const AI_USAGE_USD_TO_CNY = 7.2;

const MINIMAX_M3_STANDARD: AiTokenRateCny = {
  inputPerMillion: 2.1,
  outputPerMillion: 8.4,
  cachedPerMillion: 0.42,
};

const MINIMAX_M27: AiTokenRateCny = {
  inputPerMillion: 2.1,
  outputPerMillion: 8.4,
  cachedPerMillion: 0.42,
};

/** 模型名（大小写不敏感）→ 人民币刊例价。 */
export const AI_TOKEN_RATES_CNY: Readonly<Record<string, AiTokenRateCny>> = {
  "minimax-m3": MINIMAX_M3_STANDARD,
  "minimax-m2.7": MINIMAX_M27,
  "minimax-m2.7-highspeed": {
    inputPerMillion: 4.2,
    outputPerMillion: 16.8,
    cachedPerMillion: 0.42,
  },
  "deepseek-v4-flash": {
    inputPerMillion: 0.147 * AI_USAGE_USD_TO_CNY,
    outputPerMillion: 0.294 * AI_USAGE_USD_TO_CNY,
    cachedPerMillion: 0.0029 * AI_USAGE_USD_TO_CNY,
  },
  "claude-fable-5": {
    inputPerMillion: 9 * AI_USAGE_USD_TO_CNY,
    outputPerMillion: 45 * AI_USAGE_USD_TO_CNY,
    cachedPerMillion: 0.9 * AI_USAGE_USD_TO_CNY,
  },
};

function normalizeModelKey(model: string): string {
  return model.trim().toLowerCase();
}

export function lookupAiTokenRateCny(model: string): AiTokenRateCny | null {
  const key = normalizeModelKey(model);
  if (!key) return null;
  return AI_TOKEN_RATES_CNY[key] ?? null;
}

/**
 * 按刊例价估算单次调用费用（元）。
 * input/output 任一缺失时返回 null；cached 缺失时整段 input 按 input 单价计。
 */
export function estimateAiUsageCostCny(input: {
  model: string;
  inputTokens: number | null | undefined;
  outputTokens: number | null | undefined;
  cachedTokens?: number | null | undefined;
}): number | null {
  const rate = lookupAiTokenRateCny(input.model);
  if (!rate) return null;
  if (typeof input.inputTokens !== "number" || !Number.isFinite(input.inputTokens) || input.inputTokens < 0) {
    return null;
  }
  if (typeof input.outputTokens !== "number" || !Number.isFinite(input.outputTokens) || input.outputTokens < 0) {
    return null;
  }

  const cachedRaw = input.cachedTokens;
  const cached = typeof cachedRaw === "number" && Number.isFinite(cachedRaw) && cachedRaw > 0
    ? Math.min(cachedRaw, input.inputTokens)
    : 0;
  const uncached = Math.max(0, input.inputTokens - cached);
  const cachedRate = rate.cachedPerMillion ?? rate.inputPerMillion;

  const cost =
    (uncached / 1_000_000) * rate.inputPerMillion
    + (cached / 1_000_000) * cachedRate
    + (input.outputTokens / 1_000_000) * rate.outputPerMillion;

  if (!Number.isFinite(cost) || cost < 0) return null;
  // 保留到分；极小费用也保留非零感（至少 0.0001 展示时仍可由 UI 格式化）。
  return Math.round(cost * 10_000) / 10_000;
}
