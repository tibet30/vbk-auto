/**
 * 右侧 review 面板的头部区：
 *  - headerControls：卡片 / JSON 视图切换。
 *
 * 拆出来控制 review-summary.tsx 的体量；本组件是纯展示，不持有额外状态。
 * 就绪度徽章与生成进度条已迁到左侧「方案协作」面板（见 review.tsx）。
 * 目的地 / 规格（天数·晚数）/ 形态 hero 概览块已移除（2026-08-22）。
 */

import { Braces, LayoutGrid } from "lucide-react";
import layout from "./layout.module.less";
import styles from "./review-summary.module.less";

export type SummaryViewMode = "cards" | "json";

export interface ReviewSummaryHeadProps {
  viewMode: SummaryViewMode;
  onChangeViewMode: (mode: SummaryViewMode) => void;
}

export function AppWorkspaceReviewSummaryHead({
  viewMode,
  onChangeViewMode,
}: ReviewSummaryHeadProps) {
  return (
    <div className={`${layout.panelHeader} ${styles.summaryHeader}`}>
      <div className={`${layout.panelTitleRow} ${styles.summaryTitleRow}`}>
        <span className={layout.panelNum}>02</span>
        <strong className={layout.panelTitle}>审查结果</strong>
      </div>
      <div className={styles.headerControls} role="toolbar" aria-label="审查结果展示方式">
        <div className={styles.modeTabs} role="tablist" aria-label="切换卡片或 JSON 视图">
          <button
            type="button"
            role="tab"
            id="summary-view-cards"
            aria-controls="summary-view-panel"
            aria-selected={viewMode === "cards"}
            tabIndex={viewMode === "cards" ? 0 : -1}
            className={styles.modeTab}
            data-active={viewMode === "cards"}
            onClick={() => onChangeViewMode("cards")}
          >
            <LayoutGrid size={12} aria-hidden="true" />
            卡片视图
          </button>
          <button
            type="button"
            role="tab"
            id="summary-view-json"
            aria-controls="summary-view-panel"
            aria-selected={viewMode === "json"}
            tabIndex={viewMode === "json" ? 0 : -1}
            className={styles.modeTab}
            data-active={viewMode === "json"}
            onClick={() => onChangeViewMode("json")}
          >
            <Braces size={12} aria-hidden="true" />
            JSON 数据
          </button>
        </div>
      </div>
    </div>
  );
}
