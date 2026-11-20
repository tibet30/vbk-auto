import React from "react";
import { ArrowUp, Brain, CircleAlert, FolderOpen, LoaderCircle, MessageSquareText } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { AgentApprovalScope, AgentThreadWorkspace } from "../../../../shared/contracts-agent-runtime.js";
import { AgentWorkPanel } from "./AgentWorkPanel";
import { ArtifactPreviewModal } from "./ArtifactPreviewModal";
import { MessageMarkdown } from "../shared/message-markdown";
import { api } from "../../helpers";
import { disabledSkillIds, isSkillEnabled } from "./skill-scope";
import { agentWorkspaceErrorMessage } from "./workspace-error";
import styles from "./workspace.module.less";

interface AgentThreadViewProps {
  detail: AgentThreadWorkspace;
  sending: boolean;
  pending: boolean;
  onSend(content: string): void;
  onSelectDirectory(): void;
  onApprove(toolCallId: string, scope: AgentApprovalScope): void;
  onReject(toolCallId: string): void;
  onReconcile(toolCallId: string): void;
  onOpenArtifact(receiptId: string, mode: "open" | "reveal"): void;
  onToggleSkill(skillId: string): void;
  onResume(threadId: string): void;
  onCancel(threadId: string): void;
}

export function AgentThreadView({
  detail, sending, pending, onSend, onSelectDirectory, onApprove, onReject, onReconcile, onOpenArtifact,
  onToggleSkill, onResume, onCancel,
}: AgentThreadViewProps) {
  const [content, setContent] = useState("");
  const [preview, setPreview] = useState<{ receiptId: string; title: string; loading: boolean; html?: string; error?: string; truncated?: boolean } | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => { endRef.current?.scrollIntoView({ block: "end" }); }, [detail.messages.length, sending]);
  const openPreview = async (receiptId: string) => {
    const bridge = api();
    if (!bridge?.agentWorkspace) return;
    const receipt = detail.runtime.receipts.find((entry) => entry.id === receiptId);
    const title = receipt?.artifact?.entry ?? "网页产物";
    setPreview({ receiptId, title, loading: true });
    try {
      const result = await bridge.agentWorkspace.previewArtifact(detail.thread.id, receiptId);
      setPreview({ receiptId, title: result.entry || title, loading: false, html: result.html, truncated: result.truncated });
    } catch (reason) {
      setPreview({
        receiptId,
        title,
        loading: false,
        error: agentWorkspaceErrorMessage(reason, "无法生成预览。"),
      });
    }
  };

  const submit = () => {
    const value = content.trim();
    if (!value || sending) return;
    setContent("");
    onSend(value);
  };
  return (
    <div className={styles.threadBody}>
      <section className={styles.threadView} aria-label={detail.thread.title}>
        <header className={styles.threadHead}>
          <div><h1>{detail.thread.title}</h1><p>{threadState(detail)}</p></div>
          <button
            type="button"
            className={styles.directory}
            data-warning={detail.workingDirectoryAvailable === false}
            data-kind={detail.workingDirectoryKind ?? "none"}
            title={detail.workingDirectoryKind === "temporary"
              ? "未指定目录时自动创建的临时工作区，删除任务会一并清理；点击可换成你自己的目录"
              : "点击选择工作目录"}
            onClick={onSelectDirectory}
          >
            {detail.workingDirectoryAvailable === false ? <CircleAlert size={14} /> : <FolderOpen size={14} />}
            <span>
              {detail.thread.workingDirectory
                ? `${detail.workingDirectoryKind === "temporary" ? "临时工作区 · " : ""}${compactPath(detail.thread.workingDirectory)}${detail.workingDirectoryAvailable === false ? " · 目录不可用" : ""}`
                : "临时工作区（执行时自动创建）"}
            </span>
          </button>
        </header>
        {detail.runtime.skills.length > 0 && (
          <div className={styles.skillStrip} aria-label="本任务启用的 Skill">
            <span className={styles.skillStripLabel}>Skill</span>
            {detail.runtime.skills.map((skill) => {
              const enabled = isSkillEnabled(detail.runtime.enabledSkills, skill.id);
              return (
                <button
                  key={skill.id}
                  type="button"
                  className={styles.skillChip}
                  data-enabled={enabled}
                  aria-pressed={enabled}
                  title={skill.description}
                  onClick={() => onToggleSkill(skill.id)}
                >
                  {skill.label}
                </button>
              );
            })}
            {disabledSkillIds(detail.runtime.skills.map((skill) => skill.id), detail.runtime.enabledSkills).length > 0 && (
              <span className={styles.skillStripHint}>已停用部分能力，模型看不到对应工具</span>
            )}
          </div>
        )}
        <div className={styles.messages} aria-live="polite">
          {detail.thread.summary && (
            <details className={styles.summaryNotice}>
              <summary><Brain size={14} />较早的 {detail.thread.summary.coveredMessageCount} 条记录已压缩</summary>
              <pre>{detail.thread.summary.text}</pre>
            </details>
          )}
          {!detail.messages.length && <div className={styles.threadEmpty}><MessageSquareText size={24} /><p>继续描述目标，智能体会把这次工作保存在当前任务中。</p></div>}
          {detail.messages.map((message) => (
            <article className={styles.message} data-role={message.role} key={message.id}>
              {message.role === "assistant" && <strong className={styles.sender}>智能体</strong>}
              {message.role === "assistant"
                ? <MessageMarkdown content={message.content} />
                : <p className={styles.plainText}>{message.content}</p>}
            </article>
          ))}
          {sending && <div className={styles.running}><LoaderCircle size={15} />正在处理当前任务…</div>}
          <div ref={endRef} />
        </div>
        <div className={styles.threadComposer}>
          <textarea
            value={content}
            onChange={(event) => setContent(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); submit(); }
            }}
            placeholder="继续补充要求…"
            aria-label="继续任务"
          />
          <button type="button" onClick={submit} disabled={!content.trim() || sending} aria-label="发送">
            <ArrowUp size={16} />
          </button>
        </div>
      </section>
      <AgentWorkPanel
        threadId={detail.thread.id}
        runtime={detail.runtime}
        pending={pending || sending}
        onApprove={onApprove}
        onReject={onReject}
        onReconcile={onReconcile}
        onOpenArtifact={onOpenArtifact}
        onPreviewArtifact={(receiptId) => void openPreview(receiptId)}
        onResume={onResume}
        onCancel={onCancel}
      />
      {preview && (
        <ArtifactPreviewModal
          title={preview.title}
          html={preview.html}
          loading={preview.loading}
          error={preview.error}
          truncated={preview.truncated}
          onClose={() => setPreview(null)}
          onOpenInBrowser={() => onOpenArtifact(preview.receiptId, "open")}
        />
      )}
    </div>
  );
}

function compactPath(value: string): string {
  const parts = value.split(/[\\/]/u).filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : value;
}

function threadState(detail: AgentThreadWorkspace): string {
  if (detail.thread.status === "running") return "正在处理";
  if (detail.thread.status === "needs_attention") return "需要处理 · 可继续发送消息重试";
  if (detail.thread.summary) return `${detail.thread.messageCount} 条记录 · 已启用上下文压缩`;
  return `${detail.thread.messageCount} 条记录`;
}
