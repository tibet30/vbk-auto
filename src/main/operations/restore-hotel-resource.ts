import { randomUUID } from "node:crypto";
import type { VbkDatabase } from "../infrastructure/database/database.js";
import { platformHotelRulesRequired } from "../../shared/platform-hotel-rules.js";

type Store = Pick<VbkDatabase, "runProductTransaction" | "getProduct" | "getAgentSnapshot" | "saveAgentSnapshot"
  | "writeAutomationWithProductStatus" | "appendOperationLog" | "latestWorkflowTaskForProduct" | "updateWorkflowTask">;
const message = "住宿资源步骤已恢复：保留城市和晚数，平台自动匹配三钻、四钻、五钻，指定酒店为空。待确认后保存住宿规则并重新回读。";

/** Restore an omitted requirement locally without borrowing an old approval or claiming remote success. */
export function restoreHotelResourceCheckpoint(db: Store, id: string) {
  return db.runProductTransaction(() => {
    const current = db.getProduct(id);
    if (!current) throw new Error("产品不存在");
    const run = current.automation;
    if (!run || !platformHotelRulesRequired(current.product) || run.phases.some(p => p.phase === "hotelResource")) return current;
    const snapshot = db.getAgentSnapshot(id);
    if (run.status === "running" || snapshot?.run && ["running", "queued"].includes(snapshot.run.status))
      throw new Error("任务正在执行，不能恢复住宿资源断点");
    if (snapshot?.uncertainWrite) throw new Error("仍有不确定写入，请先只读核查");
    const at = new Date().toISOString();
    const old = structuredClone(run);
    const position = run.phases.findIndex(p => ["vehicleResource", "terms", "trafficLine", "preflight"].includes(p.phase));
    run.phases.splice(position < 0 ? run.phases.length : position, 0, { phase: "hotelResource", status: "pending" });
    for (const phase of run.phases) {
      // Vehicle finalization must include the newly saved hotel rules; other completed modules stay intact.
      if (["vehicleResource", "preflight"].includes(phase.phase) && phase.status === "completed") phase.status = "pending";
    }
    for (const phase of ["hotelResource", "vehicleResource", "preflight"]) {
      if (run.recovery?.phases[phase]?.state === "completed") delete run.recovery.phases[phase];
    }
    run.status = run.phases.some(p => p.status === "failed") ? "failed" : "queued";
    delete run.currentPhase;
    run.updatedAt = at; run.logs.push({ at, level: "info", message });
    db.writeAutomationWithProductStatus(id, run, run.status === "failed" ? "blocked" : "review");
    if (snapshot?.run) {
      for (const event of snapshot.events) {
        const approval = event.data?.approval as { status?: string } | undefined;
        if (event.type === "approval" && approval?.status === "approved") approval.status = "invalidated";
      }
      delete snapshot.pendingApproval;
      snapshot.run.status = "paused"; snapshot.run.updatedAt = at; snapshot.updatedAt = at;
      snapshot.events.push({ id: randomUUID(), runId: snapshot.run.id, type: "status", createdAt: at,
        content: message, data: { status: "paused", restoredPhase: "hotelResource", localStateOnly: true } });
      db.saveAgentSnapshot(snapshot);
    }
    const task = db.latestWorkflowTaskForProduct(id);
    if (task) db.updateWorkflowTask(task.id, { status: "needs_attention", message });
    db.appendOperationLog({ id: randomUUID(), type: "automation", name: "恢复住宿规则资源步骤", status: "succeeded",
      localProductId: id, phase: "hotelResource", startedAt: at, message,
      payload: { previousRun: old, localStateOnly: true, remoteWrites: 0, productJsonVersion: current.productJsonVersion } });
    return db.getProduct(id)!;
  });
}
