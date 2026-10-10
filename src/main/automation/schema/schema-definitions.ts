/**
 * 产品 JSON 完整 zod schema 定义 + 共享常量（barrel）：
 *   - HHMM_REGEX：被 ./schema-functions.ts 复用；
 *   - RECOMMENDATION_CATEGORIES：「推荐理由」分类白名单，与 VBK 下拉一致；
 *   - productSchema：顶层全字段校验（含 release.submitReview / publishAfterApproval 默认 true）；
 *
 * 顶级 schema 用 strict 模式拒绝额外字段，保持前后端契约稳定。
 *
 * 子文件按"产品 JSON 顶层字段"切分：
 *   - itinerary.ts / presentation.ts / operations.ts / commercial.ts / product.ts
 *   - 私有 schema（如 trafficLineAvailabilitySchema）保留在 operations.ts 内部，仅顶层用得到的 schema
 *     （itineraryDaySchema / presentationSchema / operationsSchema / commercialSchema / productSchema /
 *     recommendationItemSchema / manualReviewSchema）才在这里 re-export。
 */

import { commercialSchema } from "./schema-definitions/commercial.js";
import { itineraryDaySchema } from "./schema-definitions/itinerary.js";
import { operationsSchema } from "./schema-definitions/operations.js";
import { presentationSchema, recommendationItemSchema } from "./schema-definitions/presentation.js";
import { manualReviewSchema, productSchema } from "./schema-definitions/product.js";

export {
  PRODUCT_COVER_SOURCES,
  manualUploadCoverSchema,
  type ProductCoverSource,
} from "./schema-definitions/presentation.js";

export {
  HHMM_REGEX,
} from "./schema-definitions/operations.js";

export {
  RECOMMENDATION_CATEGORIES,
  VBK_RECOMMENDATION_CATEGORIES,
} from "../../domain/product/recommendation-categories.js";

export {
  itineraryDaySchema,
  recommendationItemSchema,
  presentationSchema,
  operationsSchema,
  commercialSchema,
  manualReviewSchema,
  productSchema,
};