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
