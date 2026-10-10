/**
 * cover-auto-fill barrel：封面自动补齐的主入口 + 谓词 / 关键词 / outcome 三个内部子模块。
 *
 * 历史 importer 继续 `import { applyAutoCoverFill, isCoverCandidateComplete, ... } from "./cover-auto-fill.js"`，
 * 符号由本文件再聚合出去。
 *
 * 子模块：
 *   - predicates.ts  safeObject / textValue / positiveInteger / isCoverCandidateComplete / isCoverCandidateSuitable / isCtripLibraryCoverComplete / pickFirstUsableCoverCandidate；
 *   - keywords.ts    pickCoverSearchKeyword / collectCoverSearchKeywords / matchesItineraryCoverPoi；
 *   - outcome.ts     AutoCoverFillOutcome 接口；
 *   - apply.ts       applyAutoCoverFill 主流程。
 */

export { applyCoverFallback } from "./cover-fallback.js";
export {
  buildCtripLibraryCoverAlternateFromCandidate,
  buildCtripLibraryCoverFromCandidate,
} from "./cover-auto-fill-images.js";
export {
  isCoverCandidateComplete,
  isCoverCandidateSuitable,
  isCtripLibraryCoverComplete,
  pickFirstUsableCoverCandidate,
} from "./cover-auto-fill/predicates.js";
export {
  matchesItineraryCoverPoi,
  pickCoverSearchKeyword,
  collectCoverSearchKeywords,
} from "./cover-auto-fill/keywords.js";
export type { AutoCoverFillOutcome } from "./cover-auto-fill/outcome.js";
export { applyAutoCoverFill } from "./cover-auto-fill/apply.js";