import type { AutomationRun, ProductDetail, ResearchTask } from "../../shared/contracts.js";
import { TibetProductConflictError, type TibetProductService } from "../infrastructure/tibet-products.js";

interface ResearchTaskSyncDb {
  getProduct(localProductId: string): ProductDetail | undefined;
  importProductSnapshot(snapshot: ProductDetail): ProductDetail;
}

function isTerminal(task: ResearchTask): boolean {
  return task.state === "confirmed" || task.state === "resolved";
}

function sameTask(left: ResearchTask, right: ResearchTask): boolean {
  return left.id === right.id || (left.type === right.type && left.label === right.label);
}

/**
 * Commit a local product mutation and its confirmed research tasks as one
 * caller-visible remote operation. Remote-only tasks are preserved, and a
 * single revision conflict is replayed on top of the server's latest snapshot.
 *
 * If this fails, deliberately leave the local durable mutation intact: callers
 * fail instead of reporting success, and the same operation can be retried.
 * Importing an older remote snapshot here would silently discard the user's
 * locally saved confirmation or field edit.
 */
export async function syncConfirmedResearchTasksToRemote(args: {
  db: ResearchTaskSyncDb;
  remote: TibetProductService;
  localProductId: string;
  broadcast(product: ProductDetail): void;
}): Promise<ProductDetail> {
  const local = args.db.getProduct(args.localProductId);
  if (!local) throw new Error("产品不存在，请刷新后重试。");
  const confirmed = local.researchTasks.filter(isTerminal);

  let remote = await args.remote.get(args.localProductId);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (!remote.revision) throw new Error("产品远端版本缺失，请刷新后重试。");
    const mergedTasks = remote.researchTasks.map((task) =>
      confirmed.find((candidate) => sameTask(candidate, task)) ?? task);
    for (const task of confirmed) {
      if (!mergedTasks.some((candidate) => sameTask(candidate, task))) mergedTasks.push(task);
    }

    try {
      const saved = await args.remote.update(
        mergeResearchSyncSnapshot(remote, local, mergedTasks),
        remote.revision,
      );
      args.db.importProductSnapshot(saved);
      args.broadcast(saved);
      return saved;
    } catch (error) {
      if (error instanceof TibetProductConflictError && attempt === 0) {
        remote = error.latest;
        continue;
      }
      throw error;
    }
  }
  throw new Error("待核查状态同步失败，请刷新后重试。");
}

/**
 * Research/review mutations own product JSON and confirmed tasks. VBK runtime
 * fields belong to the automation runner: keep the more advanced snapshot so a
 * conflict retry cannot clobber a remote workflow, and a stale remote copy
 * cannot roll back a local runner.
 */
export function mergeResearchSyncSnapshot(
  remote: ProductDetail,
  local: ProductDetail,
  researchTasks: ResearchTask[],
): ProductDetail {
  return {
    ...remote,
    ...local,
    revision: remote.revision,
    researchTasks,
    planning: local.planning ?? remote.planning,
    aiUsage: local.aiUsage ?? remote.aiUsage,
    automation: preferAutomation(local.automation, remote.automation),
    basicInfoSaved: Boolean(remote.basicInfoSaved || local.basicInfoSaved),
    productId: remote.productId || local.productId,
    vbkAccount: remote.vbkAccount || local.vbkAccount,
    updatedAt: new Date().toISOString(),
  };
}

function preferAutomation(local?: AutomationRun, remote?: AutomationRun): AutomationRun | undefined {
  if (!local) return remote;
  if (!remote) return local;
  return automationProgress(remote) >= automationProgress(local) ? remote : local;
}

function automationProgress(run: AutomationRun): number {
  const rank: Record<string, number> = {
    succeeded: 5, running: 4, queued: 3, failed: 2, cancelled: 1,
  };
  const completed = run.phases.filter((phase) => phase.status === "completed").length;
  return (rank[run.status] ?? 0) * 100 + completed;
}
