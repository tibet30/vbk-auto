import type { MainIpcContext } from "../ipc/context.js";
import { productNotFound } from "../infrastructure/db-errors.js";
import { canonicalJson, record } from "../../shared/product-storage-projection.js";
import { productCoverGenerator, type CoverGenerator } from "./generated-cover.js";

/** Explicit operator action: generate locally, retain the original, then renew review. */
export async function generateProductCover(context: MainIpcContext, id: string,
  generate: CoverGenerator = productCoverGenerator(context)) {
  if (!context.agentCore) throw new Error("审批服务尚未就绪，请稍后重试。");
  const saved = await context.productWorkflows.runExclusive(id, "ai", async () => {
    const baseline = context.db.getProduct(id);
    if (!baseline) throw productNotFound(id);
    const generated = await generate(baseline.product);
    const current = context.db.getProduct(id);
    if (!current || canonicalJson(current.product) !== canonicalJson(baseline.product)) {
      throw new Error("生成期间产品已变更，当前封面已保留，请按最新产品重新生成。");
    }
    const next = structuredClone(baseline.product);
    const presentation = record(next.presentation);
    const previous = record(presentation.cover);
    if (previous.source === "manualUpload") {
      const originals = Array.isArray(presentation.preservedManualCovers) ? presentation.preservedManualCovers : [];
      presentation.preservedManualCovers = originals.some(item => record(item).fileId === previous.fileId)
        ? originals : [...originals, structuredClone(previous)];
    }
    presentation.cover = generated;
    delete presentation.coverFallback;
    next.presentation = presentation;
    return context.productMutations.commands.mergeChanges(id, baseline, next, "user", { status: "review", notify: false });
  });
  context.emitProduct(saved);
  await context.agentCore.send(id, "已按当前产品生成并保存新的 AI 主题插画封面，原手动封面已保留。仅核验当前方案并重新请求本次审批，停在 waiting_approval；不要重新找图或生成，不沿用历史授权，禁止携程写入、上传及审批后录入交接。");
  return saved;
}
