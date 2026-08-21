import { AI_WRITABLE_PATHS } from "./schemas.js";
import { STAGE_ALLOWED_MODULES } from "./stage-contract.js";
import { buildPackageName } from "./package-name.js";
import type { OrchestratorRuntime } from "./types.js";
import type {
  ModuleOutcome,
  PlanningGenerationState,
  PlanningModule,
  PlanningSkeleton,
} from "../../shared/contracts-planning.js";

export async function ensurePackageName(args: {
  state: PlanningGenerationState;
  skeleton: PlanningSkeleton;
  runtime: OrchestratorRuntime;
}): Promise<{ ok: true; outcome?: ModuleOutcome } | { ok: false; reason: string }> {
  const acceptedModules = await args.runtime.loadAcceptedModules(args.state.localProductId);
  if (acceptedModules.includes("packageName")) return { ok: true };
  const packageName = buildPackageName(args.skeleton);
  const writeResult = await args.runtime.writeModule(args.state.localProductId, "packageName", AI_WRITABLE_PATHS.packageName, packageName);
  if (!writeResult.ok) {
    return { ok: false, reason: writeResult.reason || "本地生成套餐名写入失败" };
  }
  return {
    ok: true,
    outcome: {
      module: "packageName",
      status: "accepted",
      writePath: AI_WRITABLE_PATHS.packageName,
      acceptedFields: ["packageName"],
    },
  };
}

export function normaliseCommercialOutcomes(
  accepted: ModuleOutcome[],
  rejected: ModuleOutcome[],
): { accepted: ModuleOutcome[]; rejected: ModuleOutcome[] } {
  const order = ["packageName", ...STAGE_ALLOWED_MODULES.commercial] as readonly PlanningModule[];
  const acceptedByModule = new Map<PlanningModule, ModuleOutcome>();
  for (const outcome of accepted) {
    if (outcome.status === "accepted") acceptedByModule.set(outcome.module, outcome);
  }
  const rejectedByModule = new Map<PlanningModule, ModuleOutcome>();
  for (const outcome of rejected) {
    if (acceptedByModule.has(outcome.module)) continue;
    rejectedByModule.set(outcome.module, outcome);
  }
  const sortByStageOrder = (a: ModuleOutcome, b: ModuleOutcome) => order.indexOf(a.module) - order.indexOf(b.module);
  return {
    accepted: [...acceptedByModule.values()].sort(sortByStageOrder),
    rejected: [...rejectedByModule.values()].sort(sortByStageOrder),
  };
}
