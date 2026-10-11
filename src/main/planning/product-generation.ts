export { ProductGenerationService } from "./product-generation/service.js";
export type {
  ProductGenerationDependencies,
  ProductGenerationResult,
  ProductGenerationStage,
} from "./product-generation/types.js";
export {
  hasCompletePresentationRecommendations,
  patchRequestsRecommendations,
} from "./product-generation/validation.js";
