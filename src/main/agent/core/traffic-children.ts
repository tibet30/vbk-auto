import { randomUUID } from "node:crypto";
import type { AgentApproval, AgentSnapshot } from "../../../shared/contracts.js";
import { hasVerifiedMotherPhases } from "../../automation/automation.main/automation.main.resume-phase.js";
import { agentProductVersion, requiredAgentPhases } from "../integration-gates.js";
import { type AgentCore, asCoreInternals } from "../core.js";

/** 按钮点击是本次子产品写入授权；不复用母产品录入时的未勾选决定。 */
export async function createTrafficChildrenCommand(core: AgentCore, id: string, routeReviewAuthorized: boolean): Promise<AgentSnapshot> {
  const c = asCoreInternals(core);
  return c.command(id, async () => {
    let snapshot = c.load(id);
    if (c.active.has(id) || c.scheduled.has(id) || c.handoffs.has(id)
      || ["running", "queued", "waiting_approval", "waiting_input"].includes(snapshot.run?.status ?? "")) {
      throw new Error("当前任务尚未结束，请先完成或暂停后再录入子产品。");
    }
    if (snapshot.uncertainWrite) throw new Error("写入结果尚未核对，不能创建子产品。");
    const product = c.deps.preparationProduct?.(id);
    if (!product || !hasVerifiedMotherPhases(product)) throw new Error("请先完成母产品录入及最终回读。");
    const phases = requiredAgentPhases(product);
    if (!phases.includes("trafficLine")) throw new Error("当前方案没有可创建的交通子产品。");
    const scope = phases.map(phase => `vbk.write_phase:${phase}`);
    const precondition = await c.deps.approvalPrecondition?.(id, scope);
    if (precondition) throw new Error(precondition);
    const identity = await c.deps.accountFor(id);
    const current = c.deps.preparationProduct?.(id);
    if (!current || !hasVerifiedMotherPhases(current) || agentProductVersion(current) !== agentProductVersion(product)
      || identity.productVersion !== agentProductVersion(current) || !identity.accountKey
      || (current.vbkAccount && current.vbkAccount !== identity.accountKey)) {
      throw new Error("方案或账号已变化，请重新检查后录入子产品。");
    }
    snapshot = c.load(id);
    c.cancelPendingInteraction(snapshot, "由手动子产品录入接管。");
    snapshot.run = c.run("running");
    snapshot.run.intentVersion = await c.intent(id);
    const approval: AgentApproval = {
      id: randomUUID(), createdAt: snapshot.run.createdAt, status: "approved",
      ...identity, scope, intentVersion: snapshot.run.intentVersion,
      summary: "手动创建并录入交通子产品；保留母产品和已有子产品编号，仅保存草稿。",
      generateTrafficChildren: true, trafficChildrenOnly: true,
      trafficRouteReviewAuthorized: routeReviewAuthorized === true,
    };
    c.event(snapshot, "user", "创建并录入子产品", { trafficChildrenOnly: true });
    c.event(snapshot, "approval", "用户已授权单独录入子产品", { approval });
    c.running(snapshot);
    c.save(snapshot);
    if (!c.handoffs.tryStart(id, approval)) {
      const paused = c.load(id);
      c.pauseRun(paused, "子产品录入服务尚未就绪，请稍后重试。");
      return c.save(paused);
    }
    return c.load(id);
  });
}
