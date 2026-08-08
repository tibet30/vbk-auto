/**
 * minimax 子系统对外唯一入口：聚合 re-export MiniMaxService 类与常用的常量 / schema。
 * 实际实现见 ./minimax-service.ts / ./minimax-constants.ts，本文件不引入运行时依赖。
 */

export {
  MiniMaxService,
} from "./minimax-service.js";
export {
  hasCompleteCtripLibraryCover,
  isCoverResearchTaskSatisfiedByProduct,
  MiniMaxServiceError,
  presentationCoverValueSchema,
} from "./minimax-constants.js";
