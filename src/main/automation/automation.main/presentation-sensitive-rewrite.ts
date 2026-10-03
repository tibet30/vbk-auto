/** 产品图文反馈恢复的运行接线，候选校验与恢复状态分别由独立模块负责。 */
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { fillAndSavePresentation } from "../ctrip/presentation/main.js";
import type { AutomationRunContext } from "./automation.main.context.js";
import { writeAutomationProduct } from "./automation.main.persist.js";
import { runPresentationCopyRecovery } from "./presentation-copy-recovery.js";
import { savePresentationViaApi } from "../ctrip/presentation/presentation-api.js";
import { AutomationCancelledError } from "./automation.main.errors.js";
import { verifyPresentationImageCheckpoint } from "../ctrip/presentation/image-checkpoint.js";
export { findSensitivePresentationPaths, applySensitivePresentationRewrite, rewritePrompt } from "./presentation-copy-candidate.js";
export type { PresentationCopyPath } from "./presentation-copy-candidate.js";
type ProductWithPresentation = Record<string, any> & { presentation?: Record<string, any> };

/** UI polling updates diagnostics without changing the authorised business input. */
function businessContent(product: ProductWithPresentation | undefined) {
  if (!product) return product;
  const content = structuredClone(product);
  if (content.diagnostics) {
    delete content.diagnostics.runtime;
    delete content.diagnostics.debugSnapshot;
    if (Object.keys(content.diagnostics).length === 0) delete content.diagnostics;
  }
  return content;
}

export async function fillPresentationWithSensitiveRewrite(args: {
  ctx: AutomationRunContext;
  localProductId: string;
  page: any;
  product: ProductWithPresentation;
  productId: string;
  log: (message: string, level?: "info" | "warning" | "error") => void;
}): Promise<unknown> {
  let expectedProduct = structuredClone(args.ctx.db.getProduct(args.localProductId)?.product);
  const assertWritable = async () => {
    if (args.ctx.cancellationRequested.has(args.localProductId)) throw new AutomationCancelledError();
    await args.ctx.assertWriteAuthorized?.(args.localProductId, "presentation");
    if (args.ctx.cancellationRequested.has(args.localProductId)) throw new AutomationCancelledError();
    if (!isDeepStrictEqual(businessContent(args.ctx.db.getProduct(args.localProductId)?.product), businessContent(expectedProduct))) {
      throw new Error("产品内容已变更，已停止应用过期的图文修复。");
    }
  };
  const persist = () => {
    writeAutomationProduct(args.ctx, args.localProductId, args.product, "automating");
    expectedProduct = structuredClone(args.ctx.db.getProduct(args.localProductId)?.product);
    args.ctx.emit(args.localProductId);
  };
  let coverResult: unknown;
  return runPresentationCopyRecovery({
    ...args, store: args.ctx.db, assertWritable, persist,
    rewrite: args.ctx.presentationCopyRewriter,
    save: async (reconcile, state, remember) => {
      const options = { beforeWrite: assertWritable, reconcile };
      const imageHash = () => createHash("sha256").update(JSON.stringify([
        args.productId, args.product.presentation?.cover, args.product.presentation?.coverFallback,
      ])).digest("hex");
      if (!coverResult && state.images?.hash === imageHash()
        && await verifyPresentationImageCheckpoint(args.page, Number(args.productId), state.images.result)) {
        coverResult = state.images.result;
      }
      if (coverResult) {
        const savedWith = await savePresentationViaApi(args.page, args.product.presentation, Number(args.productId), options);
        return { advanced: true, mode: "presentation-api", productId: Number(args.productId), coverResult, savedWith };
      }
      return fillAndSavePresentation(args.page, args.product, args.productId, persist, {
        ...options, onImagesBound: (result: unknown) => {
          coverResult = result;
          state.images = { hash: imageHash(), result };
          remember();
        },
      });
    },
  });
}
