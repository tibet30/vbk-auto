import type { ProductMutationService } from "../../application/product-mutation-service.js";
import type { AutomationRunContext } from "./automation.main.context.js";
import { ensureBrowserHasBounds, markCancelled, resolveActiveButlerContext } from "./automation.main.class.helpers.js";

export function makeAutomationRunContext(args: Pick<AutomationRunContext,
  "db" | "browser" | "emit" | "advisor" | "presentationCopyRewriter" | "disambiguator" | "cancellationRequested">
  & { localProductId?: string; guard?: AutomationRunContext["assertWriteAuthorized"]; mutations?: ProductMutationService;
    exclusive: <T>(task: () => Promise<T>) => Promise<T> }): AutomationRunContext {
  return {
    db: args.db, browser: args.browser, emit: args.emit,
    agentControlled: Boolean(args.localProductId && args.guard),
    assertWriteAuthorized: args.localProductId ? args.guard : undefined,
    advisor: args.localProductId && args.guard
      ? async () => ({ summary: "阶段未完成", rootCause: "等待 Agent 根据执行结果决定后续动作", action: "wait_for_user", expectedEvidence: "权威回读结果", userInstruction: "已将错误返回 Agent，未在工具内部重复写入。" })
      : args.advisor,
    presentationCopyRewriter: args.presentationCopyRewriter,
    disambiguator: args.disambiguator,
    resolveActiveButlerContext: accountName => resolveActiveButlerContext(args.db, accountName),
    markCancelled: (_id, run, persist) => markCancelled(run, persist),
    cancellationRequested: args.cancellationRequested,
    ensureBrowserHasBounds: () => ensureBrowserHasBounds(args.browser),
    persistProduct: (id, product, status) => {
      if (args.mutations) args.mutations.replace(id, product, { status, notify: false });
      else args.db.updateProduct(id, product, status);
    },
    runVbkPageExclusive: (task, phase) => args.exclusive(async () => {
      if (args.localProductId && phase) await args.guard?.(args.localProductId, phase);
      return task();
    }),
  };
}
