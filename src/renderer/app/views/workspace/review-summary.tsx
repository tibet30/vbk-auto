/**
 * 右侧 review-summary（产品审查面板）入口 barrel。
 *
 * 拆分后保留原始 `AppWorkspaceReviewSummary` / `ReviewSummaryProps` 的公开路径，
 * 父级 renderer 通过 `import { AppWorkspaceReviewSummary, type ReviewSummaryProps }`
 * 继续使用，零调用方改动。
 *
 * 子模块：
 *   - review-summary/component.tsx       主组件 + countTopLevelKeys 工具；
 *   - review-summary/active-task-footer.tsx  当前任务 footer（核查 / 资源组匹配）；
 *   - review-summary/generating-skeleton.tsx  AI 第一版生成中的骨架占位。
 */

export { AppWorkspaceReviewSummary } from "./review-summary/component.js";
export type { ReviewSummaryProps } from "./review-summary/component.js";