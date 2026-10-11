import type { AgentApproval, AgentSnapshot } from "../../../shared/contracts.js";
import type { AgentCoreInternals } from "../core.js";

/** A resume cannot authorize a changed plan. Reopen phase A with fresh authority. */
export async function reopenChangedApproval(
  c: AgentCoreInternals, id: string, approval: AgentApproval,
): Promise<AgentSnapshot> {
  const snapshot = c.load(id);
  let identity;
  try {
    identity = await c.deps.accountFor(id);
  } catch {
    c.pauseRun(snapshot, "当前账号或方案尚未核验，请恢复登录后继续。");
    return c.save(snapshot);
  }
  if (snapshot.uncertainWrite || c.handoffs.has(id)
    || (identity.accountKey === approval.accountKey && identity.productVersion === approval.productVersion)) {
    c.pauseRun(snapshot, "自动录入状态尚未核验，请稍后继续处理。");
    return c.save(snapshot);
  }
  c.cancelPendingInteraction(snapshot, "方案或账号已变化，旧确认失效。");
  // Invalidate every copy so historical recovery cannot reuse the old approval.
  for (const event of snapshot.events) {
    const previous = event.data?.approval as AgentApproval | undefined;
    if (previous?.id === approval.id) previous.status = "invalidated";
  }
  c.event(snapshot, "approval", "方案或账号已变化，旧确认失效；保留录入检查点，重新核验当前方案。", {
    approval: { ...approval, status: "invalidated" },
  });
  c.pauseRun(snapshot, "旧确认已失效，转入当前方案核验。");
  snapshot.run = c.run("queued");
  snapshot.run.intentVersion = `${identity.productVersion}:${snapshot.run.id}`;
  c.event(snapshot, "user", "继续当前本地规划与资源核验：读取已保存方案，仅修复当前缺项，保留原路线和已完成录入检查点；手动封面尺寸不足时保留原图并查找合格图库替代。核验通过后重新请求审批，审批前禁止任何 VBK 写入。", {
    preparationResume: true, changedApprovalRecovery: true,
  });
  c.running(snapshot);
  const saved = c.save(snapshot);
  c.loop.schedule(id);
  return saved;
}
