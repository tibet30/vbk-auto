/**
 * WorkbenchModule：
 *   - 三态卡片（ready / todo / emphasis），icon + stateLabel + 详情 + hint + action；
 *   - 渲染为 <article> + header / p / footer 三段结构；
 *   - 是 Workbench 视图的核心模块壳。
 */

import type { ReactNode } from "react";
import styles from "../components.module.less";

export function WorkbenchModule({
  icon,
  title,
  detail,
  state,
  stateLabel,
  hint,
  action,
}: {
  icon: ReactNode;
  title: string;
  detail: string;
  state: "ready" | "todo" | "emphasis";
  stateLabel?: string;
  hint?: string;
  action: ReactNode;
}) {
  return <article className={styles.moduleCard} data-state={state}>
    <header className={styles.moduleHead}>
      <span className={styles.moduleIcon} aria-hidden="true">{icon}</span>
      <div className={styles.moduleHeader}>
        <strong className={styles.moduleTitle}>
          {title}
          {stateLabel && <span className={styles.moduleBadge} data-state={state}>{stateLabel}</span>}
        </strong>
      </div>
    </header>
    <p className={styles.moduleBody}>{detail}</p>
    <footer className={styles.moduleFoot}>
      {hint ? <span className={styles.moduleHint}>{hint}</span> : <span />}
      {action}
    </footer>
  </article>;
}