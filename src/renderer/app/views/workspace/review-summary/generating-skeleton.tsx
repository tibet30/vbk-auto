/**
 * AI 还在生成第一版且 itinerary 为空时的占位骨架：
 *  - hero 段（旋转图标 + 文案 + 20–60 秒预估）；
 *  - 三张"假卡片"占位，让运营在等待期间能看到审查面板正在工作。
 *
 * 与 review-summary.tsx 内其它组件无依赖；只在卡片视图 + isGenerating 分支被引用。
 */

import { LoaderCircle } from "lucide-react";
import styles from "../review-summary.module.less";

export function GeneratingSkeleton() {
  return (
    <div className={styles.generatingPane} role="status" aria-live="polite">
      <div className={styles.generatingHero}>
        <span className={styles.generatingSpinner} aria-hidden="true">
          <LoaderCircle size={20} />
        </span>
        <strong className={styles.generatingTitle}>AI 正在生成完整方案…</strong>
        <small className={styles.generatingHint}>通常 20–60 秒，期间可在左侧继续对话补齐要求。</small>
      </div>
      <div className={styles.generatingSkeleton} aria-hidden="true">
        <div className={styles.skelCard}>
          <div className={styles.skelRow}>
            <span className={`${styles.skelBar} ${styles.skelBarLg}`} />
            <span className={`${styles.skelBar} ${styles.skelBarXs}`} />
          </div>
          <span className={`${styles.skelBar} ${styles.skelBarFull}`} />
          <span className={`${styles.skelBar} ${styles.skelBarFull}`} />
          <span className={`${styles.skelBar} ${styles.skelBarMd}`} />
        </div>
        <div className={styles.skelCard}>
          <div className={styles.skelRow}>
            <span className={`${styles.skelBar} ${styles.skelBarLg}`} />
            <span className={`${styles.skelBar} ${styles.skelBarSm}`} />
          </div>
          <span className={`${styles.skelBar} ${styles.skelBarFull}`} />
          <span className={`${styles.skelBar} ${styles.skelBarMd}`} />
        </div>
        <div className={styles.skelCard}>
          <div className={styles.skelRow}>
            <span className={`${styles.skelBar} ${styles.skelBarLg}`} />
          </div>
          <span className={`${styles.skelBar} ${styles.skelBarFull}`} />
          <span className={`${styles.skelBar} ${styles.skelBarSm}`} />
        </div>
      </div>
    </div>
  );
}