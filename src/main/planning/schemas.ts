/**
 * 阶段级结构化输出 schema（barrel）：
 *   - atoms.ts：requiredText / vbkSubtitle / VBK_RECOMMENDATION_VALUES；
 *   - basic.ts：basicInfo + research + presentation schema；
 *   - modules.ts：itinerary / pricing / inventory / terms / release / packageName /
 *     operations（skeleton）schema；
 *   - validate.ts：通用 validate + validateModuleValue + validateResearchTaskProposal
 *     + parseStageOutput + isPlanningStage；
 *   - system-prompt.ts：buildSystemPrompt + getWritablePaths + AI_WRITABLE_PATHS
 *     re-export。
 *
 * 任何 schema 校验失败都视为 invalid_model_output —— orchestrator 触发 bounded retry。
 */

import {
  validateModuleValue,
  validateResearchTaskProposal,
  parseStageOutput,
  isPlanningStage,
  validate,
} from "./schemas/validate.js";

export {
  requiredText,
  vbkSubtitle,
  VBK_RECOMMENDATION_VALUES,
  VBK_SELECTABLE_RECOMMENDATION_VALUES,
} from "./schemas/atoms.js";
export {
  basicInfoModuleValueSchema,
  presentationModuleValueSchema,
  researchTaskProposalSchema,
} from "./schemas/basic.js";
export {
  inventoryModuleValueSchema,
  itineraryModuleValueSchema,
  operationsHotelTierUpdateSchema,
  packageNameModuleValueSchema,
  pricingModuleValueSchema,
  releaseModuleValueSchema,
  termsModuleValueSchema,
} from "./schemas/modules.js";
export {
  validate,
  validateModuleValue,
  validateResearchTaskProposal,
  parseStageOutput,
  isPlanningStage,
} from "./schemas/validate.js";
export {
  AI_WRITABLE_PATHS,
  STAGE_ALLOWED_MODULES,
  buildSystemPrompt,
  getWritablePaths,
} from "./schemas/system-prompt.js";