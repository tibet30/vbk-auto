/**
 * 右侧 review 面板里的「待处理事项」统一列表。
 *
 * 只展示 readiness.issues 这一套待处理规则：
 *  - researchTasks 只用于给同语义 issue 绑定"核查填写"出口，不额外增加列表项；
 *  - 普通 readiness blocker 仍可送入对话 / 文本补齐提示；
 *  - 列表本身不滚动，高度跟随内容；外层 .scroll 负责整个 review 面板的
 *    纵向滚动，避免嵌套滚动导致底部被截断。
 *
 * 设计上不复用通用 .collapsible 折叠壳——折叠态由父级 review-summary 持有；
 * 默认展开、可滚动；视觉密度对齐「每日行程」section。
 */

import { ChevronDown, ListChecks, LoaderCircle, RefreshCw } from "lucide-react";
import type { ProductReadiness, ResearchTask } from "../../../../shared/contracts-types.js";
import shared from "../shared.module.less";
import styles from "./review-summary-issues.module.less";
import { buildOpenIssueRows } from "./review-summary-open-issues.helpers.js";

export interface ReviewSummaryOpenIssuesProps {
  readiness: ProductReadiness;
  taskList: ResearchTask[];
  setComposerInput?: (value: string) => void;
  setVerificationNote: (value: string) => void;
  setActiveTask: (id: string | null) => void;
  /** 整个「待处理事项」模块是否被收起；由父级持有，产品切换时复位。 */
  collapsed: boolean;
  /** 切换整个「待处理事项」模块的展开 / 收起。 */
  onToggleCollapsed: () => void;
  refreshing: boolean;
  onRefresh: () => void;
}

function sendToComposer(setComposerInput: ((value: string) => void) | undefined, fallback: (value: string) => void, content: string) {
  const setter = setComposerInput ?? fallback;
  setter(content);
}

export function AppWorkspaceReviewSummaryOpenIssues({
  readiness,
  taskList,
  setComposerInput,
  setVerificationNote,
  setActiveTask,
  collapsed,
  onToggleCollapsed,
  refreshing,
  onRefresh,
}: ReviewSummaryOpenIssuesProps) {
  const rows = buildOpenIssueRows(readiness, taskList);
  if (rows.length === 0) return null;

  const total = rows.length;

  return (
    <section className={styles.block} aria-label="统一待处理事项" data-collapsed={collapsed}>
      <div className={styles.head}>
        <button
          type="button"
          className={styles.headToggle}
          onClick={onToggleCollapsed}
          aria-expanded={!collapsed}
          aria-controls="open-issues-body"
        >
          <span className={styles.headIcon} aria-hidden="true">
            <ListChecks size={13} />
          </span>
          <strong className={styles.headTitle}>待处理事项</strong>
          <small className={styles.headMeta}>{total} 项</small>
          <span className={styles.headChevron} aria-hidden="true">
            <ChevronDown size={13} />
          </span>
        </button>
        <button
          type="button"
          className={styles.refreshBtn}
          disabled={refreshing}
          aria-busy={refreshing}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onRefresh();
          }}
        >
          {refreshing ? <LoaderCircle size={13} className={styles.refreshSpin} /> : <RefreshCw size={13} />}
          <span>{refreshing ? "刷新中…" : "刷新"}</span>
        </button>
      </div>
      {!collapsed && (
        <div className={styles.body} id="open-issues-body" data-min-visible={total >= 3}>
          <ul className={styles.list}>
            {rows.map((issue, index) => (
              <li key={`${issue.label}-${index}`} className={styles.item}>
                <span className={styles.itemIndex}>{index + 1}</span>
                <span className={styles.itemBody}>
                  <strong className={styles.itemLabel}>{issue.label}</strong>
                  <span className={styles.itemDetail}>{issue.detail}</span>
                </span>
                <span className={styles.itemAction}>
                  <button
                    type="button"
                    className={`${shared.btn} ${shared.btnSm} ${styles.itemActionBtn}`}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      if (issue.taskId) {
                        setActiveTask(issue.taskId);
                        setVerificationNote("");
                        return;
                      }
                      sendToComposer(
                        setComposerInput,
                        setVerificationNote,
                        issue.actionPrompt,
                      );
                    }}
                  >处理</button>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
