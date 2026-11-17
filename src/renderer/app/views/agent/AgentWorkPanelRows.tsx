/**
 * 工作面板的行组件：动作、收据、产物。
 *
 * 与 `AgentWorkPanel` 分开是为了让面板骨架保持可读——这里只做"把事实渲染成一行"，
 * 不含任何状态判定。
 */

import React from "react";
import { ExternalLink, Eye, FolderOpen, Search } from "lucide-react";
import type {
  AgentActionReceipt,
  AgentReceiptStatus,
  AgentToolCallRecord,
  AgentToolCallStatus,
} from "../../../../shared/contracts-agent-runtime.js";
import styles from "./panel.module.less";

export function ToolCallRow({ call, pending, onReconcile }: {
  call: AgentToolCallRecord;
  pending: boolean;
  onReconcile(toolCallId: string): void;
}) {
  return (
    <div className={styles.rowPlain}>
      <span className={styles.time}>{formatTime(call.createdAt)}</span>
      <span className={styles.rowMain}>
        <span className={styles.rowTitle}>
          <span className={styles.rowName}>{call.toolName}</span>
          <span className={styles.status} data-tone={toolTone(call.status)}>{TOOL_STATUS_LABEL[call.status]}</span>
        </span>
        <span className={styles.rowSummaryText}>{call.summary}</span>
        {call.error && <span className={styles.rowSummaryText} data-error="true">{call.error}</span>}
        {call.status === "uncertain" && (
          <span className={styles.rowActions}>
            <button type="button" className={styles.secondary} disabled={pending} onClick={() => onReconcile(call.id)}>
              <Search size={11} />核查结果
            </button>
          </span>
        )}
      </span>
    </div>
  );
}

export function ReceiptRow({ receipt }: { receipt: AgentActionReceipt }) {
  return (
    <details className={styles.row}>
      <summary className={styles.rowSummary}>
        <span className={styles.time}>{formatTime(receipt.createdAt)}</span>
        <span className={styles.rowMain}>
          <span className={styles.rowTitle}>
            <span className={styles.rowName}>{receipt.action}</span>
            <span className={styles.status} data-tone={receiptTone(receipt.status)}>{RECEIPT_STATUS_LABEL[receipt.status]}</span>
          </span>
          <span className={styles.rowSummaryText}>{receipt.targetKey}</span>
        </span>
      </summary>
      <div className={styles.receiptBody}>
        <p><b>结果</b>{receipt.result}</p>
        {receipt.detail && <p><b>细节</b>{receipt.detail}</p>}
        {receipt.before && <p><b>变更前</b>{receipt.before}</p>}
      </div>
    </details>
  );
}

export function ArtifactRow({ receipt, pending, onOpenArtifact, onPreviewArtifact }: {
  receipt: AgentActionReceipt;
  pending: boolean;
  onOpenArtifact(receiptId: string, mode: "open" | "reveal"): void;
  onPreviewArtifact(receiptId: string): void;
}) {
  const artifact = receipt.artifact!;
  const name = artifact.kind === "directory"
    ? lastSegment(artifact.path)
    : lastSegment(artifact.files[0]?.path ?? artifact.path);
  const bytes = artifact.files.reduce((total, file) => total + file.bytes, 0);
  const detail = artifact.kind === "directory"
    ? `${artifact.files.length} 个文件 · ${formatBytes(bytes)}${artifact.entry ? ` · 入口 ${artifact.entry}` : ""}`
    : formatBytes(bytes);
  const files = artifact.kind === "directory" ? artifact.files : [];
  return (
    <div className={styles.rowPlain}>
      <span className={styles.time}>{formatTime(receipt.createdAt)}</span>
      <span className={styles.rowMain}>
        <span className={styles.rowTitle}>
          <span className={styles.rowName}>{name}</span>
          <span className={styles.status} data-tone="success">{artifact.kind === "directory" ? "文件夹" : "文件"}</span>
        </span>
        <span className={styles.rowSummaryText}>{detail}</span>
        {files.length > 0 && (
          <span className={styles.fileList}>
            {files.map((file) => <span key={file.path}>{file.path}</span>)}
          </span>
        )}
        <span className={styles.rowActions}>
          {artifact.kind === "directory" && (
            <button type="button" className={styles.secondary} disabled={pending}
              onClick={() => onPreviewArtifact(receipt.id)}>
              <Eye size={11} />预览
            </button>
          )}
          <button type="button" className={styles.secondary} disabled={pending}
            onClick={() => onOpenArtifact(receipt.id, "open")}>
            <ExternalLink size={11} />打开
          </button>
          <button type="button" className={styles.secondary} disabled={pending}
            onClick={() => onOpenArtifact(receipt.id, "reveal")}>
            <FolderOpen size={11} />在文件夹中显示
          </button>
        </span>
      </span>
    </div>
  );
}

export function DiffPreview({ text }: { text: string }) {
  return (
    <pre className={styles.diff}>
      {text.split("\n").map((line, index) => (
        <span key={index} className={styles.diffLine} data-line={diffLineTone(line)}>{line || " "}</span>
      ))}
    </pre>
  );
}

export function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--:--";
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} 字节`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function lastSegment(value: string): string {
  const parts = value.split(/[\\/]/u).filter(Boolean);
  return parts[parts.length - 1] ?? value;
}

const TOOL_STATUS_LABEL: Record<AgentToolCallStatus, string> = {
  awaiting_approval: "待审批",
  denied: "已拒绝",
  executing: "执行中",
  succeeded: "已成功",
  failed: "失败",
  uncertain: "结果不确定",
};

const RECEIPT_STATUS_LABEL: Record<AgentReceiptStatus, string> = {
  succeeded: "已成功",
  failed: "失败",
  uncertain: "结果不确定",
};

function toolTone(status: AgentToolCallStatus): string {
  if (status === "awaiting_approval" || status === "uncertain") return "warning";
  if (status === "executing") return "active";
  if (status === "succeeded") return "success";
  if (status === "failed") return "danger";
  return "muted";
}

function receiptTone(status: AgentReceiptStatus): string {
  if (status === "succeeded") return "success";
  if (status === "failed") return "danger";
  return "warning";
}

function diffLineTone(line: string): "add" | "remove" | "context" {
  if (line.startsWith("+++") || line.startsWith("---")) return "context";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "remove";
  return "context";
}
