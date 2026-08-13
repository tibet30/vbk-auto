import { Check, ChevronDown, ChevronRight, Copy, ExternalLink, FileWarning, RefreshCw, ScrollText } from "lucide-react";
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

/** 复制纯文本。Electron 渲染进程里 navigator.clipboard 通常可用；保留 textarea
 * fallback，避免某些环境 clipboard 不可用时按钮毫无反应。 */
async function copyText(value: string): Promise<boolean> {
  if (!value) return false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // 忽略并走 fallback
  }
  try {
    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
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

function stageLabel(entry: OperationLogEntry): string | null {
  if (!entry.stage) return null;
  return entry.phase ? `${entry.stage} / ${entry.phase}` : entry.stage;
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
  const [copied, setCopied] = useState<"target" | "message" | null>(null);
  const hasMessage = Boolean(entry.message);
  const tone = STATUS_TONE[entry.status];

  async function handleCopy(value: string, slot: "target" | "message") {
    const ok = await copyText(value);
    if (!ok) return;
    setCopied(slot);
    window.setTimeout(() => {
      setCopied((current) => (current === slot ? null : current));
    }, 1400);
  }

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
              {entry.productName && <span className={styles.opMetaItem}>{entry.productName}</span>}
              {entry.stage && (
                <>
                  {entry.productName && <span className={styles.opMetaSep}>·</span>}
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
                  <button
                    type="button"
                    className={styles.opMetaTarget}
                    onClick={() => void handleCopy(entry.target!, "target")}
                    title={`点击复制：${entry.target}`}
                    aria-label={`复制目标选择器：${entry.target}`}
                  >
                    <span className={styles.opMetaTargetText}>{entry.target}</span>
                    {copied === "target" ? (
                      <Check size={11} aria-hidden="true" className={styles.opMetaTargetCopied} />
                    ) : (
                      <Copy size={11} aria-hidden="true" className={styles.opMetaTargetCopyIcon} />
                    )}
                  </button>
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
                className={styles.opRowBtn}
                onClick={() => onRetry(entry)}
                aria-label={`重试「${entry.name}」`}
                title="重试这一步"
              >
                <RefreshCw size={12} aria-hidden="true" />
                <span>重试</span>
              </button>
            )}
            <button
              type="button"
              className={styles.opRowBtn}
              onClick={() => onShowDetail(entry)}
              aria-label={`打开「${entry.name}」关联产品并跳转到对应页面`}
              title="打开该产品并跳转到对应的 VBK 页面"
            >
              <ExternalLink size={12} aria-hidden="true" />
              <span>详情</span>
            </button>
            {hasMessage && (
              <button
                type="button"
                className={styles.opRowToggle}
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
          <header className={styles.opRowErrorHead}>
            <span className={styles.opRowErrorTitle}>
              <FileWarning size={12} aria-hidden="true" />
              错误消息
            </span>
            <span className={styles.opRowErrorMeta}>
              <time dateTime={entry.startedAt}>{formatAbsolute(entry.startedAt)}</time>
              {stageLabel(entry) && (
                <>
                  <span className={styles.opRowErrorMetaSep}>·</span>
                  <span>{stageLabel(entry)}</span>
                </>
              )}
            </span>
            <button
              type="button"
              className={styles.opRowErrorCopy}
              onClick={() => void handleCopy(entry.message!, "message")}
              aria-label="复制错误消息"
            >
              {copied === "message" ? (
                <>
                  <Check size={11} aria-hidden="true" /> 已复制
                </>
              ) : (
                <>
                  <Copy size={11} aria-hidden="true" /> 复制
                </>
              )}
            </button>
          </header>
          <pre className={styles.opRowErrorText}>{entry.message}</pre>
        </div>
      )}
    </article>
  );
}
