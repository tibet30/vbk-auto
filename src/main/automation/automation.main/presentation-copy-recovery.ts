import { createHash } from "node:crypto";
import type { AiResponse } from "../../../shared/contracts.js";
import type { VbkCopyFeedbackStore, VbkCopyRecovery } from "../../planning/vbk-copy-feedback.js";
import { PresentationSensitiveWordsError } from "../ctrip/presentation/save-monitor.js";
import { PresentationCopyRejectedError } from "../ctrip/presentation/copy-errors.js";
import { applySensitivePresentationRewrite, findSensitivePresentationPaths, rewritePrompt } from "./presentation-copy-candidate.js";

type Product = Record<string, any> & { presentation?: Record<string, any> };
export function presentationCopyHash(product: Product): string {
  const p = product.presentation;
  return createHash("sha256").update(JSON.stringify([p?.recommendation, p?.features, p?.recommendations])).digest("hex");
}

/** 本地修复预算独立持久化，普通重试、Agent 接管或重启不会重置同一份拒绝文案。 */
export async function runPresentationCopyRecovery(args: {
  localProductId: string;
  productId: string;
  product: Product;
  store: VbkCopyFeedbackStore;
  save: (reconcile: boolean, state: VbkCopyRecovery, remember: () => void) => Promise<unknown>;
  rewrite?: (request: { message: string; product: Record<string, unknown> }) => Promise<AiResponse>;
  assertWritable: () => Promise<void>;
  persist: () => void;
  log: (message: string, level?: "info" | "warning" | "error") => void;
}): Promise<unknown> {
  const hash = presentationCopyHash(args.product);
  const previous = args.store.getPresentationCopyRecovery(args.localProductId);
  const continuing = previous && previous.productId === args.productId && previous.status !== "completed"
    && (previous.currentHash === hash || previous.inputHash === hash);
  const state: VbkCopyRecovery = continuing ? structuredClone(previous) : {
    productId: args.productId, inputHash: hash, currentHash: hash, rewrites: 0, words: [], status: "running", history: [],
    images: previous?.productId === args.productId ? previous.images : undefined,
  };
  state.status = "running";
  const remember = () => args.store.savePresentationCopyRecovery(args.localProductId, state);
  let rejection: PresentationSensitiveWordsError | undefined;
  const learn = (error: PresentationSensitiveWordsError) => {
    const paths = findSensitivePresentationPaths(args.product, error.sensitiveWords);
    const source = error instanceof PresentationCopyRejectedError ? error.source : "checkSensitiveWord";
    for (const word of error.sensitiveWords) {
      args.store.recordCopyFeedback({ word, module: "presentation", paths, source, detail: error.message });
    }
    state.words = [...new Set([...state.words, ...error.sensitiveWords])];
    state.history.push({ at: new Date().toISOString(), source, detail: error.message, paths });
    remember();
  };
  try {
    await args.assertWritable();
    // 已知反馈也经过同一个局部修复入口，不扩散到其他模块或 POI 身份字段。
    const known = [...new Set([...state.words, ...args.store.listRejectedPresentationWords()])]
      .filter(word => findSensitivePresentationPaths(args.product, [word]).length);
    if (known.length) {
      rejection = new PresentationCopyRejectedError(known, 200, "local-feedback", `本地图文词库命中：${known.join("、")}`);
      state.words = [...new Set([...state.words, ...known])];
    }
    for (;;) {
      await args.assertWritable();
      if (!rejection) {
        try {
          const result = await args.save(Boolean(continuing) || state.rewrites > 0, state, remember);
          state.status = "completed";
          remember();
          if (state.rewrites) args.log("产品图文已自动调整并通过远端回读，继续后续录入", "info");
          return result;
        } catch (error) {
          if (!(error instanceof PresentationSensitiveWordsError)) throw error;
          learn(error);
          rejection = error;
        }
      }
      const paths = findSensitivePresentationPaths(args.product, state.words);
      if (!paths.length) throw new Error(`平台非法关键词无法在提交的产品图文中定位：${state.words.join("、")}`);
      if (!args.rewrite || state.rewrites >= 2) throw new Error(`产品图文自动修复未完成，已使用 ${state.rewrites}/2 轮：${rejection.message}`);
      state.rewrites += 1;
      remember(); // AI 调用前计数，崩溃或无效输出同样消耗预算。
      args.log(`正在调整平台未接受的文案：${state.words.join("、")}（${state.rewrites}/2）`, "info");
      const before = structuredClone(args.product.presentation);
      const response = await args.rewrite({ message: rewritePrompt(state.words, paths, args.product.presentation), product: structuredClone(args.product) });
      await args.assertWritable();
      const candidate = structuredClone(args.product);
      try {
        applySensitivePresentationRewrite(candidate, response, paths, state.words);
        if (presentationCopyHash(candidate) === presentationCopyHash(args.product)) throw new Error("AI 没有修改命中文案。");
      } catch (error) {
        state.history.push({ at: new Date().toISOString(), source: "rewrite-validation", detail: rejection.message, paths, error: String(error) });
        remember();
        if (state.rewrites >= 2) throw error;
        continue;
      }
      state.currentHash = presentationCopyHash(candidate);
      state.history.push({ at: new Date().toISOString(), source: "rewrite", detail: rejection.message, paths, before, after: candidate.presentation });
      remember(); // 候选持久化前写恢复记录，启动后可核对两种哈希。
      args.product.presentation = candidate.presentation;
      try { args.persist(); } catch (error) { args.product.presentation = before; throw error; }
      rejection = undefined;
    }
  } catch (error) {
    state.status = "failed";
    remember();
    throw error;
  }
}
