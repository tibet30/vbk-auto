/**
 * 右侧 review 面板的头部区：
 *  - headerControls：卡片 / JSON 视图切换 + 就绪度徽章；
 *  - hero：目的地、规格、形态徽章 + 生成进度 / 就绪度进度条。
 *
 * 拆出来控制 review-summary.tsx 的体量；本组件是纯展示，不持有额外状态。
 */

import { Braces, LayoutGrid, MapPin } from "lucide-react";
import shared from "../shared.module.less";
import layout from "./layout.module.less";
import styles from "./review-summary.module.less";

export type SummaryViewMode = "cards" | "json";

export interface ReviewSummaryHeadProps {
  destination: string;
  spec: string;
  form: "privateTour" | "groupTour" | "unknown";
  viewMode: SummaryViewMode;
  onChangeViewMode: (mode: SummaryViewMode) => void;
  readinessLabel: string;
  readinessState: "confirmed" | "researching" | "needsConfirmation" | "blocked" | "neutral";
  /** 数字部分：根据 isGenerating / isPlanning 决定显示百分数 / 阶段计数 / "—"。 */
  progressValue: string;
  /** 进度条下方小标签。 */
  progressCaption: string;
  /** 进度条宽度（0..100）。 */
  progressPercent: number;
  /** hero 色调：根据 readiness 计算后传入。 */
  heroTone: "ready" | "blocked" | "neutral";
}

const FORM_LABEL: Record<"privateTour" | "groupTour" | "unknown", string> = {
  privateTour: "私家团",
  groupTour: "跟团游",
  unknown: "草稿",
};

export function AppWorkspaceReviewSummaryHead({
  destination,
  spec,
  form,
  viewMode,
  onChangeViewMode,
  readinessLabel,
  readinessState,
  progressValue,
  progressCaption,
  progressPercent,
  heroTone,
}: ReviewSummaryHeadProps) {
  return (
    <>
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
          <span className={styles.modeBarMeta}>
            <span className={shared.state} data-state={readinessState}>
              {readinessLabel}
            </span>
          </span>
        </div>
      </div>

      <section className={styles.hero} data-tone={heroTone}>
        <div className={styles.heroMain}>
          <div className={styles.heroDestinationRow}>
            <span className={styles.heroIcon}><MapPin size={13} aria-hidden="true" /></span>
            <strong className={styles.heroDestination}>{destination}</strong>
            <span className={styles.heroForm} data-form={form}>{FORM_LABEL[form]}</span>
          </div>
          <small className={styles.heroSpec}>{spec}</small>
        </div>
        <div className={styles.heroProgressBlock}>
          <div className={styles.heroProgressValue}>
            <strong>{progressValue}</strong>
            <small>{progressCaption}</small>
          </div>
          <div className={styles.heroProgressTrack}>
            <span
              className={styles.heroProgressFill}
              style={{ width: `${Math.min(100, Math.max(0, progressPercent))}%` }}
            />
          </div>
        </div>
      </section>
    </>
  );
}
