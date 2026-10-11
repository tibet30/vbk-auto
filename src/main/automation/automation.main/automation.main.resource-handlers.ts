import { productNeedsVehicleResource } from "../../../shared/product-form.js";
import type { AutomationRun } from "../../../shared/contracts.js";
import type { parseProduct } from "../schema/schema.js";
import type { AutomationRunContext } from "./automation.main.context.js";
import { buildFillMap } from "./automation.main.run-one/fill-map.js";

/** 保留已移除的历史失败断点，使原 run 能跳过它并继续后续阶段。 */
export function resourceRecoveryPhases(product: unknown, phases: string[], previous: AutomationRun | undefined, retryFrom?: string): string[] {
  if (retryFrom !== "vehicleResource" || productNeedsVehicleResource(product)
    || phases.includes(retryFrom) || previous?.status !== "failed"
    || !previous.phases.some(item => item.phase === retryFrom && item.status === "failed")) return phases;
  const next = previous.phases.slice(previous.phases.findIndex(item => item.phase === retryFrom) + 1)
    .find(item => phases.includes(item.phase));
  if (!next) return phases;
  const result = [...phases];
  result.splice(result.indexOf(next.phase), 0, retryFrom);
  return result;
}

export function resourcePhaseHandlers(input: {
  ctx: AutomationRunContext; localProductId: string; page: any;
  product: ReturnType<typeof parseProduct>; productId: string; run: AutomationRun;
  log: (message: string, level?: "info" | "warning" | "error") => void;
  persist: () => void;
  executePhase: (phase: string, execute: () => Promise<unknown>) => Promise<unknown>;
}): Record<string, () => Promise<unknown>> {
  const fillMap = buildFillMap({ ctx: input.ctx, localProductId: input.localProductId,
    page: input.page, productData: input.product, productId: input.productId,
    run: input.run, log: input.log, persist: input.persist });
  return Object.fromEntries(["hotelResource", "vehicleResource", "trafficLine"].map(phase =>
    [phase, () => input.executePhase(phase, fillMap[phase])]));
}

/** 不属于当前团态的历史失败阶段只更新执行记录，绝不进入平台写入锁。 */
export function completeUnsupportedVehiclePhase(
  product: unknown, run: AutomationRun, phase: string, index: number,
  log: (message: string, level?: "info" | "warning" | "error") => void,
  persist: () => void,
): boolean {
  if (phase !== "vehicleResource" || productNeedsVehicleResource(product)) return false;
  run.phases[index].status = "completed";
  if (run.recovery?.phases[phase]) {
    run.recovery.phases[phase] = {...run.recovery.phases[phase], state: "completed", finalError: undefined};
  }
  log("跳过历史用车资源阶段：当前产品团态不支持资源组绑定，保留行程用车与费用配置。");
  persist();
  return true;
}
