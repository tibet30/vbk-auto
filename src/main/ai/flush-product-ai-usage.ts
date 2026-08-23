/**
 * 把本地采集到的 AI usage 事件 append 进 Tibet 产品快照。
 * 409 冲突时按 event.id 合并后重试一次。
 */

import { logWarn } from "../../shared/log-timestamp.js";
import type { AiUsageEvent, ProductDetail } from "../../shared/contracts.js";
import { TibetProductConflictError, type TibetProductService } from "../infrastructure/tibet-products.js";
import { appendAiUsage } from "./ai-usage-merge.js";

export async function flushProductAiUsage(args: {
  remote: TibetProductService;
  localProductId: string;
  events: readonly AiUsageEvent[];
  importSnapshot: (snapshot: ProductDetail) => ProductDetail;
  broadcast: (product: ProductDetail) => void;
}): Promise<ProductDetail | undefined> {
  if (!args.events.length) return undefined;
  try {
    const latest = await args.remote.get(args.localProductId);
    if (!latest.revision) {
      logWarn("[ai-usage] skip flush: missing revision", { localProductId: args.localProductId });
      return undefined;
    }
    const snapshot: ProductDetail = {
      ...latest,
      aiUsage: appendAiUsage(latest.aiUsage, args.events),
      updatedAt: new Date().toISOString(),
    };
    try {
      const saved = await args.remote.update(snapshot, latest.revision);
      const cached = args.importSnapshot(saved);
      args.broadcast(cached);
      return cached;
    } catch (error) {
      if (!(error instanceof TibetProductConflictError)) throw error;
      const merged: ProductDetail = {
        ...error.latest,
        aiUsage: appendAiUsage(error.latest.aiUsage, args.events),
        updatedAt: new Date().toISOString(),
      };
      if (!error.latest.revision) {
        args.broadcast(error.latest);
        return error.latest;
      }
      const saved = await args.remote.update(merged, error.latest.revision);
      const cached = args.importSnapshot(saved);
      args.broadcast(cached);
      return cached;
    }
  } catch (error) {
    logWarn("[ai-usage] flush failed", {
      localProductId: args.localProductId,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}
