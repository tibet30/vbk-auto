import { productNeedsVehicleResource } from "../../../shared/product-form.js";
import type { AutomationRun } from "../../../shared/contracts.js";
import type { parseProduct } from "../schema/schema.js";
import type { AutomationRunContext } from "./automation.main.context.js";
import { ensureHotelResourceApi } from "../ctrip/hotel-resource-api.js";
import { ensureVehicleResourceApi } from "../ctrip/vehicle-resource-api.js";
import { ensureTrafficLinePhase } from "../ctrip/traffic-line/run-phase.js";
import { DEFAULT_TRAFFIC_LINE_CONFIG } from "../../../shared/contracts-traffic-line.js";
import { writeAutomationProduct } from "./automation.main.persist.js";

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
  const {ctx, localProductId, page, product, productId, run, log, persist, executePhase} = input;
  return {
        hotelResource: () => executePhase("hotelResource", async () => {
          const result = await ensureHotelResourceApi(page, product, productId!);
          if ("source" in result && result.source === "ctrip" && result.verified === true) {
            const operations = product.operations!;
            operations.hotelResource = {
              source: "ctrip",
              resourceName: result.resourceName ?? String(product.itinerary.find((day) => Boolean(day.hotel))?.hotel ?? "酒店资源"),
              hotelTier: result.hotelTier,
              diamond: result.diamond as 3 | 4 | 5,
              candidates: product.itinerary.find((day) => Array.isArray(day.hotelCandidates))?.hotelCandidates,
              dailyCandidates: result.dailyCandidates,
            };
            writeAutomationProduct(ctx, localProductId, product as unknown as Record<string, unknown>, "automating");
          }
          return result;
        }),
        vehicleResource: () => executePhase("vehicleResource", () => ensureVehicleResourceApi(page, product, productId!)),
        trafficLine: () => executePhase("trafficLine", () => {
          return ensureTrafficLinePhase({
            page,
            parentProductId: productId!,
            config: product.operations?.trafficLine ?? DEFAULT_TRAFFIC_LINE_CONFIG,
            itinerary: product.itinerary,
            log,
            checkpoint: run.trafficLine,
            onCheckpoint: (checkpoint) => {
              run.trafficLine = checkpoint;
              for (const child of checkpoint.children) {
                if (child.childProductId) ctx.browser.addPinnedProductId?.(child.childProductId);
              }
              persist();
            },
            disambiguator: ctx.disambiguator,
            product,
          });
        }),
  };
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
