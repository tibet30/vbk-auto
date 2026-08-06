import { ChevronDown, ChevronRight, FileWarning, RefreshCw, ScrollText } from "lucide-react";
import { useState } from "react";
import type { OperationLogEntry } from "../../../../shared/contracts.js";
import shared from "../shared.module.less";
import { OperationTypeIcon, OPERATION_TYPE_LABEL } from "./OperationTypeIcon";
import styles from "./OperationLogRow.module.less";

function formatDuration(ms: number): string {
  if (ms <= 0) return "—";
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}

function formatRelative(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "时间未知";
  const diff = Date.now() - date.getTime();
  if (diff < 0) return "刚刚";
  const sec = Math.round(diff / 1000);
  if (sec < 30) return "刚刚";
  if (sec < 60) return `${sec} 秒前`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day} 天前`;
  return date.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}

function formatAbsolute(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "时间未知";
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

const STATUS_LABEL = {
  succeeded: "成功",
  failed: "失败",
  skipped: "已跳过",
  running: "进行中",
} as const;

const STATUS_TONE = {
  succeeded: "ok",
  failed: "block",
  skipped: "skip",
  running: "ai",
} as const;

function typeState(entry: OperationLogEntry): "ok" | "fail" | "skip" | "run" | "neutral" {
  if (entry.status === "failed") return "fail";
  if (entry.status === "skipped") return "skip";
  if (entry.status === "running") return "run";
  if (entry.status === "succeeded") return "ok";
  return "neutral";
}

export function OperationLogRow({
  entry,
  canRetry,
  onRetry,
  onShowDetail,
}: {
  entry: OperationLogEntry;
  canRetry: boolean;
  onRetry: (entry: OperationLogEntry) => void;
  onShowDetail: (entry: OperationLogEntry) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const hasMessage = Boolean(entry.message);
  const tone = STATUS_TONE[entry.status];

  return (
    <article className={styles.opRow} data-state={entry.status}>
      <div className={styles.opRowMain}>
        <div className={styles.opRowLead}>
          <OperationTypeIcon type={entry.type} state={typeState(entry)} />
          <div className={styles.opRowNameBlock}>
            <div className={styles.opRowNameLine}>
              <span className={styles.opRowName}>{entry.name}</span>
              <span className={styles.opRowTypeTag}>{OPERATION_TYPE_LABEL[entry.type]}</span>
              {entry.attempt > 1 && (
                <span className={styles.opRowAttempt} title={`第 ${entry.attempt} 次尝试`}>
                  第 {entry.attempt} 次
                </span>
              )}
            </div>
            <div className={styles.opRowMetaLine}>
              {entry.projectName && <span className={styles.opMetaItem}>{entry.projectName}</span>}
              {entry.stage && (
                <>
                  {entry.projectName && <span className={styles.opMetaSep}>·</span>}
                  <span className={styles.opMetaItem}>
                    <ScrollText size={11} aria-hidden="true" />
                    {entry.stage}
                    {entry.phase && <span className={styles.opMetaPhase}>/ {entry.phase}</span>}
                  </span>
                </>
              )}
              {entry.target && (
                <>
                  <span className={styles.opMetaSep}>·</span>
                  <span className={`${styles.opMetaItem} ${styles.opMetaTarget}`} title={entry.target}>
                    {entry.target}
                  </span>
                </>
              )}
            </div>
          </div>
        </div>

        <div className={styles.opRowMetaCol}>
          <span className={styles.opStatus} data-state={tone}>
            {entry.status === "running" && <span className={styles.opStatusDot} aria-hidden="true" />}
            {STATUS_LABEL[entry.status]}
          </span>
          <time
            className={styles.opTime}
            dateTime={entry.startedAt}
            title={formatAbsolute(entry.startedAt)}
          >
            {formatRelative(entry.startedAt)}
          </time>
          <span className={styles.opDuration} title={`${entry.durationMs} ms`}>
            {formatDuration(entry.durationMs)}
          </span>
          <div className={styles.opRowActions}>
            {canRetry && (
              <button
                type="button"
                className={shared.opIconBtn}
                onClick={() => onRetry(entry)}
                aria-label={`重试「${entry.name}」`}
                title="重试这一步"
              >
                <RefreshCw size={13} />
              </button>
            )}
            <button
              type="button"
              className={shared.opIconBtn}
              onClick={() => onShowDetail(entry)}
              aria-label={`查看「${entry.name}」详情`}
              title="查看详情"
            >
              <ChevronRight size={13} />
            </button>
            {hasMessage && (
              <button
                type="button"
                className={shared.opIconBtn}
                onClick={() => setExpanded((value) => !value)}
                aria-label={expanded ? "收起错误消息" : "展开错误消息"}
                aria-expanded={expanded}
                title={expanded ? "收起" : "展开"}
              >
                {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              </button>
            )}
          </div>
        </div>
      </div>

      {hasMessage && expanded && (
        <div className={styles.opRowError} role="note" data-state={tone}>
          <FileWarning size={13} aria-hidden="true" />
          <pre className={styles.opRowErrorText}>{entry.message}</pre>
        </div>
      )}
    </article>
  );
}
