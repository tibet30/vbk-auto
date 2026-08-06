/* VBK Desktop — operation-log sub-components and hooks
 * Helper bits used by the operation log page itself. */

import { useEffect, useState, type ReactNode } from "react";
import { History, LoaderCircle, X } from "lucide-react";
import type { OperationLogPage } from "../../../../shared/contracts.js";
import { api } from "../../helpers";
import shared from "../shared.module.less";
import rowStyles from "./OperationLogRow.module.less";
import summaryStyles from "./summary.module.less";
import typeIconStyles from "./OperationTypeIcon.module.less";
import styles from "./index.module.less";

type Notice = { kind: "info" | "warn"; text: string } | null;

export function SummaryCard({
  icon,
  label,
  value,
  tone,
  sublabel,
}: {
  icon: ReactNode;
  label: string;
  value: number;
  tone: "ok" | "block" | "skip" | "neutral";
  sublabel: string;
}) {
  return (
    <div className={summaryStyles.opSummaryCard} data-tone={tone}>
      <span className={summaryStyles.opSummaryIcon} aria-hidden="true">
        {icon}
      </span>
      <div className={summaryStyles.opSummaryBody}>
        <span className={summaryStyles.opSummaryLabel}>{label}</span>
        <strong className={summaryStyles.opSummaryValue}>{value}</strong>
        <span className={summaryStyles.opSummarySub}>{sublabel}</span>
      </div>
    </div>
  );
}

export function OperationLogSkeleton() {
  return (
    <div className={styles.opListItems} aria-busy="true">
      {Array.from({ length: 4 }).map((_, index) => (
        <div key={index} className={`${rowStyles.opRow} ${styles.opRowSkeleton}`} aria-hidden="true">
          <div className={rowStyles.opRowMain}>
            <div className={rowStyles.opRowLead}>
              <span className={typeIconStyles.opTypeIcon} data-state="neutral" />
              <div className={rowStyles.opRowNameBlock}>
                <span className={`${styles.opSkelLine} ${styles.opSkelLineLg}`} />
                <span className={`${styles.opSkelLine} ${styles.opSkelLineSm}`} />
              </div>
            </div>
            <div className={rowStyles.opRowMetaCol}>
              <span className={styles.opSkelPill} />
              <span className={`${styles.opSkelLine} ${styles.opSkelLineXs}`} />
              <span className={`${styles.opSkelLine} ${styles.opSkelLineXs}`} />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

export function EmptyLogState({ hasFilter, onClear }: { hasFilter: boolean; onClear: () => void }) {
  return (
    <div className={`${shared.emptyState} ${styles.opEmpty}`}>
      <History size={26} />
      <h3>{hasFilter ? "没有匹配的日志" : "还没有自动化操作记录"}</h3>
      <p>
        {hasFilter
          ? "试着放宽筛选条件，或清空关键词查看全部操作。"
          : "触发一次自动录入或手动重跑某阶段后，浏览器自动化每一步都会留在这里。"}
      </p>
      {hasFilter && (
        <button className={shared.btn} onClick={onClear}>
          <X size={14} />
          清空筛选
        </button>
      )}
    </div>
  );
}

/**
 * 把后端 refreshedAt 渲染成「5 分钟前 / 14:23」这种相对写法，
 * 避免在标题区域出现「2025-10-12 14:46:27」这种冗长格式。
 */
export function formatRefreshedAt(iso: string): string {
  if (!iso) return "尚未刷新";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "尚未刷新";
  const diff = Date.now() - date.getTime();
  if (diff < 0) return "刚刚";
  const sec = Math.round(diff / 1000);
  if (sec < 30) return "刚刚";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  return date.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/**
 * 顶层 hook：把操作日志的加载、过滤、刷新集中到一处，
 * 让 AppView 不必关心 store / query 字符串。
 */
export function useOperationLogState(apiAvailable: boolean) {
  const [page, setPage] = useState<OperationLogPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshedAtLabel, setRefreshedAtLabel] = useState("尚未刷新");
  const [notice, setNotice] = useState<Notice>(null);

  const refresh = async (filter?: import("../../../../shared/contracts.js").OperationLogQuery) => {
    if (!apiAvailable || !api()?.operationLog) {
      setNotice({ kind: "warn", text: "操作日志接口尚未接入主进程，先用内置样例预览。" });
      return;
    }
    setLoading(true);
    try {
      const next = await api()!.operationLog.load(filter);
      setPage(next);
      setRefreshedAtLabel(formatRefreshedAt(next.refreshedAt));
    } catch (error) {
      setNotice({ kind: "warn", text: error instanceof Error ? error.message : "无法加载操作日志。" });
    } finally {
      setLoading(false);
    }
  };

  // 每分钟把 refreshedAt 重新渲染为相对时间；不需要重新拉数据。
  useEffect(() => {
    if (!page) return;
    setRefreshedAtLabel(formatRefreshedAt(page.refreshedAt));
    const interval = window.setInterval(() => {
      setRefreshedAtLabel(formatRefreshedAt(page.refreshedAt));
    }, 60_000);
    return () => window.clearInterval(interval);
  }, [page?.refreshedAt]);

  return { page, setPage, loading, setLoading, refreshedAtLabel, setRefreshedAtLabel, notice, setNotice, refresh };
}

// Re-exported so other modules can import the type
export type { Notice };
