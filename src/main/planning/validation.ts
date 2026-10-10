/**
 * 规划 completeness / deep / rewind 校验（barrel）：
 *   - completeness.ts：validateCompleteness + REQUIRED_FOR_COMPLETION；
 *   - validators-basic.ts：basicInfo / itinerary / presentation 字段级校验；
 *   - validators-commercial.ts：commercial（packageName / pricing / inventory
 *     / terms / release）+ skeleton（operations）；
 *   - rewind.ts：MODULE_TO_STAGE + earliestInvalidStage + rewindForInvalid；
 *   - helpers.ts：textValue / asRecord / asArray / productHasModule 共享工具。
 */

import type { ModuleOutcome, PlanningModule, PlanningSkeleton } from "../../shared/contracts-planning.js";
import { REQUIRED_FOR_COMPLETION, requiredModules, validateCompleteness, type ValidationResult } from "./validation/completeness.js";
import { productHasModule } from "./validation/helpers.js";
import {
  validateBasic,
  validateItinerary,
  validatePresentation,
} from "./validation/validators-basic.js";
import {
  validateInventory,
  validatePackageName,
  validatePricing,
  validateRelease,
  validateSkeleton,
  validateTerms,
} from "./validation/validators-commercial.js";
import {
  MODULE_TO_STAGE,
  earliestInvalidStage,
  rewindForInvalid,
} from "./validation/rewind.js";

export {
  REQUIRED_FOR_COMPLETION,
  validateCompleteness,
  requiredModules,
  type ValidationResult,
} from "./validation/completeness.js";
export {
  MODULE_TO_STAGE,
  earliestInvalidStage,
  rewindForInvalid,
} from "./validation/rewind.js";

/**
 * Deep validate 模块内容：
 *   - itinerary：长度 = skeleton.days，days 是 1..n 顺序且唯一，每天都有必填字段；
 *   - presentation：恰好 3 条互不重复 recommendations，每条 category 命中白名单；
 *   - commercial：每个子字段（pricing / inventory / release / terms）结构合法；
 *   - skeleton：hotelTier 命中白名单，pickupCity / transport 必填。
 *
 * 返回一组缺失 / 不合法的模块清单；空数组代表全部模块内容合法。
 */
export function deepValidateModules(args: {
  skeleton: PlanningSkeleton;
  product: Record<string, unknown>;
  acceptedModules: readonly PlanningModule[];
  now?: string;
}): { invalid: ModuleOutcome[] } {
  const acceptedSet = new Set(args.acceptedModules);
  const isAccepted = (module: PlanningModule) => acceptedSet.has(module);
  const hasModule = (module: PlanningModule) => productHasModule(args.product, module);
  const trigger = (module: PlanningModule) => isAccepted(module) || hasModule(module);

  const checks: Array<ModuleOutcome | null> = [
    trigger("basicInfo") ? validateBasic(args.product, isAccepted("basicInfo")) : null,
    trigger("itinerary")
      ? validateItinerary({
          product: args.product, expectedDays: args.skeleton.days, accepted: isAccepted("itinerary"),
        })
      : null,
    trigger("presentation") ? validatePresentation(args.product, isAccepted("presentation")) : null,
    trigger("packageName") ? validatePackageName(args.product, isAccepted("packageName")) : null,
    trigger("pricing") ? validatePricing(args.product, isAccepted("pricing")) : null,
    trigger("inventory") ? validateInventory(args.product, isAccepted("inventory")) : null,
    trigger("terms") ? validateTerms(args.product, isAccepted("terms")) : null,
    trigger("release") ? validateRelease(args.product, isAccepted("release")) : null,
    trigger("skeleton") ? validateSkeleton(args.product, isAccepted("skeleton")) : null,
  ];
  return { invalid: checks.filter((entry): entry is ModuleOutcome => Boolean(entry)) };
}