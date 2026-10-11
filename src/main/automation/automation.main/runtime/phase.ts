import type { AutomationRunContext } from "../automation.main.context.js";
import type { AutomationRun } from "../../../../shared/contracts.js";
import { AutomationCancelledError } from "../automation.main.errors.js";
import { executeApiWithPhasePageSync, recordPhaseRetry } from "../automation.main.retry-navigation.js";
import { runDraftPhaseWithRecovery } from "../optional-traffic-phase.js";
import type { AutomationLog } from "./session.js";

export interface PhaseExecution {
  ctx: AutomationRunContext;
  localProductId: string;
  run: AutomationRun;
  page: import("playwright").Page;
  productId?: string;
  manualCover: boolean;
  log: AutomationLog;
  persist: () => void;
}

/** Exactly one page entry and authorization check per attempt, shared by both runners. */
export async function executeDraftPhase(input: PhaseExecution, phase: string, executeApi: () => Promise<unknown>) {
  const { ctx, localProductId, run, page, productId, log, persist } = input;
  const assertActive = () => {
    if (ctx.cancellationRequested.has(localProductId)) throw new AutomationCancelledError();
  };
  assertActive();
  const row = run.phases.find(item => item.phase === phase);
  if (!row) throw new Error(`未注册的阶段：${phase}`);
  if (!productId) throw new Error("产品 ID 缺失，无法继续后续阶段。");
  run.currentPhase = phase;
  row.status = "running";
  persist();
  return ctx.runVbkPageExclusive(async () => {
    assertActive();
    return executeApiWithPhasePageSync({
      page, productId, phase, log,
      isPageVisible: () => ctx.browser.isVisible(),
      ensureBrowserHasBounds: ctx.ensureBrowserHasBounds,
      navigate: url => ctx.browser.navigate(url),
      requiresPhasePage: phase === "presentation" && input.manualCover,
      executeApi,
    });
  }, phase);
}

export function recoverDraftPhase(input: PhaseExecution, phase: string, basicInfoSaved: boolean, execute: () => Promise<unknown>) {
  const { ctx, localProductId, run, productId, log, persist } = input;
  const index = run.phases.findIndex(item => item.phase === phase);
  return runDraftPhaseWithRecovery({
    run, phase,
    completedPhases: run.phases.slice(0, index).filter(item => item.status === "completed").map(item => item.phase),
    productIdExists: Boolean(productId), basicInfoSaved, execute, advisor: ctx.advisor,
    applyAction: async (action, attempt) => {
      if (action === "wait_for_user") throw new Error("applyAction 不应收到 wait_for_user");
      recordPhaseRetry({ productId, phase, action, attempt, log });
    },
    log, persist, shouldCancel: () => ctx.cancellationRequested.has(localProductId),
  });
}
