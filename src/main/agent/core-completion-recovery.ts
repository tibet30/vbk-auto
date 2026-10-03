import type { AgentSnapshot } from "../../shared/contracts.js";
import type { AgentCoreDependencies } from "./types.js";
import { AgentSnapshotManager, materialWriteResults } from "./core-snapshot.js";

/** Repair the old no-write success without starting background work from a read. */
export function recoverPrematureCompletion(
  id: string, snapshot: AgentSnapshot, deps: AgentCoreDependencies, snapshots: AgentSnapshotManager,
): void {
  if (snapshot.run?.status !== "completed" || materialWriteResults(snapshot).length
    || !deps.requiresCompletionVerification?.(id, snapshot)) return;
  snapshots.pause(snapshot, "已纠正提前结束状态：本地规划与资源核验尚未完成，可继续处理。");
}
