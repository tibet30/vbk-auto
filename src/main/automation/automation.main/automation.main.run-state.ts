import type { AutomationRun } from "../../../shared/contracts.js";

/**
 * 设置完整自动录入在第一个页面上的初始状态。
 *
 * 新产品还没有 productId 时，当前页面是负责创建产品壳的销售控制；
 * basic 只有在销售控制返回并保存 productId 后，才由 basicExecute 进入。
 */
export function initializeAutomationStartPhase(run: AutomationRun, productId: string | undefined): void {
  const basicPhase = run.phases.find((phase) => phase.phase === "basic");
  if (!basicPhase) throw new Error("自动录入缺少 basic 阶段");

  if (productId) {
    run.currentPhase = "basic";
    basicPhase.status = "running";
    return;
  }

  run.currentPhase = "saleControl";
  basicPhase.status = "pending";
}

/**
 * 销售控制 API 完成远端回读后，才把产品壳作为已完成落入运行状态。
 *
 * 销售控制不是 draftPhases 的普通阶段：它创建 VBK 产品壳，后续所有 API 都
 * 依赖其 productId。因此将它记录在 recovery 中，并显式切换到 basic，避免
 * 产品壳已落库但界面仍停在「销售控制进行中」或尚未推送完成态。
 */
export function completeVerifiedSaleControlPhase(run: AutomationRun): void {
  const basicPhase = run.phases.find((phase) => phase.phase === "basic");
  if (!basicPhase) throw new Error("自动录入缺少 basic 阶段");

  run.recovery ??= { phases: {} };
  run.recovery.phases.saleControl = {
    phase: "saleControl",
    state: "completed",
    attempts: [],
  };
  run.currentPhase = "basic";
  basicPhase.status = "running";
}
