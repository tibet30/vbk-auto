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

import { useState } from "react";
import { ChevronDown, ListChecks, LoaderCircle, RefreshCw, Trash2 } from "lucide-react";
import type { ProductDetail, ProductReadiness, ResearchTask } from "../../../../shared/contracts-types.js";
import shared from "../shared.module.less";
import styles from "./review-summary-issues.module.less";
import { buildOpenIssueRows } from "./review-summary-open-issues.helpers.js";
import type { PoiIssueDeleteTarget } from "../../../../shared/poi-issue-delete.js";

export interface ReviewSummaryOpenIssuesProps {
  product: ProductDetail;
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
  hotelStateRefreshNeeded?: boolean;
  /** 删除 POI 待处理项，并同步从每日行程移除对应景点。 */
  onDeletePoiIssue: (target: PoiIssueDeleteTarget, name: string) => Promise<void>;
}

function sendToComposer(setComposerInput: ((value: string) => void) | undefined, fallback: (value: string) => void, content: string) {
  const setter = setComposerInput ?? fallback;
  setter(content);
}

export function AppWorkspaceReviewSummaryOpenIssues({
  product,
  readiness,
  taskList,
  setComposerInput,
  setVerificationNote,
  setActiveTask,
  collapsed,
  onToggleCollapsed,
  refreshing,
  onRefresh,
  hotelStateRefreshNeeded = false,
  onDeletePoiIssue,
}: ReviewSummaryOpenIssuesProps) {
  const [deletingKey, setDeletingKey] = useState<string | null>(null);
  const rows = buildOpenIssueRows(readiness, taskList, product);
  if (rows.length === 0 && !hotelStateRefreshNeeded) return null;

  const total = rows.length;

  return (
    <section className={styles.block} aria-label={total ? "统一待处理事项" : "酒店状态同步"} data-collapsed={collapsed}>
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
          <strong className={styles.headTitle}>{total ? "待处理事项" : "酒店状态同步"}</strong>
          {total > 0 && <small className={styles.headMeta}>{total} 项</small>}
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
          <span>{refreshing ? "刷新中…" : hotelStateRefreshNeeded ? "核验酒店草稿" : "刷新"}</span>
        </button>
      </div>
      {!collapsed && total > 0 && (
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
                  >{issue.taskId ? "手动确认" : "处理"}</button>
                  {issue.poiDeleteTarget && (
                    <button
                      type="button"
                      className={`${shared.btn} ${shared.btnSm} ${styles.itemDeleteBtn}`}
                      data-variant="danger"
                      aria-label={`删除 POI：${issue.poiName ?? issue.label}`}
                      title="删除该 POI，并从每日行程中移除"
                      disabled={deletingKey !== null}
                      onClick={async (event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        if (deletingKey !== null) return;
                        const name = issue.poiName ?? issue.label;
                        if (!window.confirm(`删除「${name}」？待处理事项会同步关闭，每日行程中的该 POI 也会被移除。`)) return;
                        const key = `${issue.label}-${index}`;
                        setDeletingKey(key);
                        try {
                          await onDeletePoiIssue(issue.poiDeleteTarget!, name);
                        } catch {
                          // 父级 action 已把失败原因写入 notice，这里只负责复位按钮。
                        } finally {
                          setDeletingKey(null);
                        }
                      }}
                    >
                      {deletingKey === `${issue.label}-${index}`
                        ? <LoaderCircle size={13} aria-hidden="true" />
                        : <Trash2 size={13} aria-hidden="true" />}
                    </button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
