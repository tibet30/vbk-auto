import type { AutomationRun } from "../../../../shared/contracts.js";
import type { AutomationRunContext } from "../automation.main.context.js";

export type AutomationLog = (message: string, level?: "info" | "warning" | "error") => void;

/** Every runner persists the same run before notifying its observers. */
export function automationSession(ctx: AutomationRunContext, localProductId: string, run: AutomationRun) {
  const persist = () => {
    ctx.db.saveAutomation(localProductId, run);
    ctx.emit(localProductId);
  };
  const log: AutomationLog = (message, level = "info") => {
    run.logs.push({ at: new Date().toISOString(), message, level });
    persist();
  };
  const fail = (error: unknown, phase = run.currentPhase) => {
    run.status = "failed";
    run.currentPhase = phase;
    const row = run.phases.find(item => item.phase === phase);
    if (row && row.status !== "completed") row.status = "failed";
    const message = error instanceof Error ? error.message : String(error);
    if (phase) {
      run.recovery ??= { phases: {} };
      const previous = run.recovery.phases[phase];
      run.recovery.phases[phase] = {
        ...previous, phase, state: "needs_user", attempts: previous?.attempts ?? [],
        finalError: message,
      };
    }
    ctx.db.setProductLifecycle(localProductId, { status: "blocked" });
    log(message, "error");
  };
  const cancel = () => {
    ctx.db.setProductLifecycle(localProductId, { status: "blocked" });
    ctx.markCancelled(localProductId, run, persist);
  };
  return { persist, log, fail, cancel };
}
