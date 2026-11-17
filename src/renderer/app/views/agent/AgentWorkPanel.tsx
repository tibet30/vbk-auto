import React from "react";
import { AlertTriangle, Check, Layers, Play, ShieldAlert, Square, X } from "lucide-react";
import type {
  AgentApprovalRequest,
  AgentApprovalScope,
  AgentRunStatus,
  AgentRuntimeSnapshot,
} from "../../../../shared/contracts-agent-runtime.js";
import { ArtifactRow, DiffPreview, ReceiptRow, ToolCallRow, formatTime } from "./AgentWorkPanelRows.js";
import styles from "./panel.module.less";

export interface AgentWorkPanelProps {
  threadId: string;
  runtime: AgentRuntimeSnapshot;
  pending: boolean;
  onApprove(toolCallId: string, scope: AgentApprovalScope): void;
  onReject(toolCallId: string): void;
  onReconcile(toolCallId: string): void;
  onOpenArtifact(receiptId: string, mode: "open" | "reveal"): void;
  onPreviewArtifact(receiptId: string): void;
  onResume(threadId: string): void;
  onCancel(threadId: string): void;
}

/** 只有存在运行事实时才占用第三栏；纯闲聊不渲染。 */
const ACTIVE_RUN_STATUS: AgentRunStatus[] = [
  "running",
  "waiting_approval",
  "needs_attention",
  "uncertain",
  "rejected",
  "cancelled",
  "failed",
];

export function shouldShowWorkPanel(runtime: AgentRuntimeSnapshot): boolean {
  if (runtime.approval) return true;
  if (runtime.run && ACTIVE_RUN_STATUS.includes(runtime.run.status)) return true;
  if (runtime.toolCalls.length > 0) return true;
  // 多轮任务需要回看历史，即使当前没有进行中的动作。
  if ((runtime.runs?.length ?? 0) > 1) return true;
  // 写入排队同样是必须让运营看见的事实：另一个任务正占着同一后台账号。
  if (runtime.writeQueues?.length) return true;
  // 外部工具连不上属于必须让运营看见的问题，即使还没有任何运行。
  if (runtime.externalTools?.some((tool) => tool.state !== "ready")) return true;
  // 运行已结束、工具调用滚出窗口时，产物仍然要能打开——否则产物面板会整块消失。
  return runtime.receipts.some((receipt) => receipt.artifact);
}

export function AgentWorkPanel({
  threadId, runtime, pending, onApprove, onReject, onReconcile, onOpenArtifact, onPreviewArtifact,
  onResume, onCancel,
}: AgentWorkPanelProps) {
  if (!shouldShowWorkPanel(runtime)) return null;
  const { run, approval, toolCalls, receipts, skills, externalTools, writeQueues, runs } = runtime;
  // 只有多轮任务才需要历史；单次运行看顶部状态就够了。
  const history = (runs ?? []).filter((entry) => entry.id !== run?.id);
  const cancellable = run?.status === "running" || run?.status === "waiting_approval";
  // 只有 needs_attention 能"继续"：uncertain 必须先核查，待审批必须先批准或拒绝。
  const resumable = run?.status === "needs_attention";
  const scopes = approval ? approvalScopes(approval) : [];
  const artifacts = receipts.filter((receipt) => receipt.artifact).slice().reverse();
  return (
    <aside className={styles.panel} aria-label="运行工作面板">
      <header className={styles.head}>
        <div className={styles.headTop}><ShieldAlert size={14} /><h2>运行面板</h2></div>
        <p className={styles.intent}>{run?.intent || "当前任务还没有记录运行意图"}</p>
        <div className={styles.statusLine}>
          <span className={styles.status} data-tone={run ? runTone(run.status) : "muted"}>
            {run ? RUN_STATUS_LABEL[run.status] : "无运行记录"}
          </span>
          {run && <span className={styles.step}>第 {run.step}/{run.maxSteps} 步</span>}
        </div>
        {run?.error && <p className={styles.runError}><AlertTriangle size={12} />{run.error}</p>}
        {(cancellable || resumable) && (
          <div className={styles.runBar}>
            {resumable && (
              <button type="button" className={styles.resume} disabled={pending}
                onClick={() => onResume(threadId)}>
                <Play size={11} />继续运行
              </button>
            )}
            {cancellable && (
              <button type="button" className={styles.cancel} disabled={pending} onClick={() => onCancel(threadId)}>
                <Square size={11} />取消运行
              </button>
            )}
          </div>
        )}
      </header>
      <div className={styles.body}>
        {approval && (
          <section className={styles.approval} aria-label="需要授权">
            <div className={styles.approvalHead}>
              <ShieldAlert size={13} />
              <strong>需要授权</strong>
              <span className={styles.risk} data-risk={approval.risk}>{RISK_LABEL[approval.risk]}</span>
            </div>
            <dl className={styles.facts}>
              <dt>Skill</dt><dd>{approval.skillLabel}</dd>
              <dt>动作</dt><dd>{approval.actionLabel}</dd>
              <dt>目标</dt><dd className={styles.mono}>{approval.targetKey}</dd>
              <dt>账号</dt><dd className={styles.mono}>{approval.accountKey}</dd>
              {approval.directory && <><dt>授权目录</dt><dd className={styles.mono}>{approval.directory}</dd></>}
            </dl>
            <p className={styles.impact}><b>预计影响</b>{approval.summary}</p>
            {approval.diff && <DiffPreview text={approval.diff} />}
            <div className={styles.actions}>
              {scopes.includes("once") && (
                <button type="button" className={styles.primary} disabled={pending}
                  onClick={() => onApprove(approval.toolCallId, "once")}>
                  <Check size={12} />仅本次允许
                </button>
              )}
              {scopes.includes("thread") && (
                <button type="button" className={styles.secondary} disabled={pending}
                  onClick={() => onApprove(approval.toolCallId, "thread")}>
                  <Layers size={12} />本任务内允许该目录
                </button>
              )}
              <button type="button" className={styles.deny} disabled={pending}
                onClick={() => onReject(approval.toolCallId)}>
                <X size={12} />拒绝
              </button>
            </div>
          </section>
        )}
        {history.length > 0 && (
          <section className={styles.section} aria-label="历史运行">
            <h3 className={styles.sectionHead}>历史运行<span>最近 {history.length} 次</span></h3>
            <div className={styles.rows}>
              {history.map((entry) => (
                <details className={styles.row} key={entry.id}>
                  <summary className={styles.rowSummary}>
                    <span className={styles.time}>{formatTime(entry.updatedAt)}</span>
                    <span className={styles.rowMain}>
                      <span className={styles.rowTitle}>
                        <span className={styles.rowName}>{entry.intent}</span>
                        <span className={styles.status} data-tone={runTone(entry.status)}>
                          {RUN_STATUS_LABEL[entry.status]}
                        </span>
                      </span>
                      <span className={styles.rowSummaryText}>第 {entry.step}/{entry.maxSteps} 步</span>
                    </span>
                  </summary>
                  {entry.error && (
                    <div className={styles.receiptBody}><p><b>结束原因</b>{entry.error}</p></div>
                  )}
                </details>
              ))}
            </div>
          </section>
        )}
        {writeQueues && writeQueues.length > 0 && (
          <section className={styles.section} aria-label="写入队列">
            <h3 className={styles.sectionHead}>写入队列<span>{writeQueues.length} 个账号</span></h3>
            <div className={styles.rows}>
              {writeQueues.map((queue) => (
                <div className={styles.rowPlain} key={queue.accountKey}>
                  <span className={styles.time}>写</span>
                  <span className={styles.rowMain}>
                    <span className={styles.rowTitle}>
                      <span className={styles.rowName}>{queue.accountKey}</span>
                      <span className={styles.status} data-tone={queue.running ? "active" : "warning"}>
                        {queue.running ? "正在写" : "排队中"}
                      </span>
                    </span>
                    <span className={styles.rowSummaryText}>
                      {queue.waiting > 0 ? `排队 ${queue.waiting} 个写操作` : "无排队"}
                      {queue.holderThreadId ? ` · 持有任务 ${queue.holderThreadId.slice(0, 8)}` : ""}
                    </span>
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}
        {toolCalls.length > 0 && (
          <section className={styles.section} aria-label="动作">
            <h3 className={styles.sectionHead}>动作<span>{toolCalls.length} 条</span></h3>
            <div className={styles.rows}>
              {toolCalls.slice().reverse().map((call) => (
                <ToolCallRow key={call.id} call={call} pending={pending} onReconcile={onReconcile} />
              ))}
            </div>
          </section>
        )}
        {receipts.length > 0 && (
          <section className={styles.section} aria-label="收据">
            <h3 className={styles.sectionHead}>收据<span>{receipts.length} 条</span></h3>
            <div className={styles.rows}>
              {receipts.slice().reverse().map((receipt) => <ReceiptRow key={receipt.id} receipt={receipt} />)}
            </div>
          </section>
        )}
        {artifacts.length > 0 && (
          <section className={styles.section} aria-label="产物">
            <h3 className={styles.sectionHead}>产物<span>{artifacts.length} 个</span></h3>
            <div className={styles.rows}>
              {artifacts.map((receipt) => (
                <ArtifactRow
                  key={`artifact-${receipt.id}`}
                  receipt={receipt}
                  pending={pending}
                  onOpenArtifact={onOpenArtifact}
                  onPreviewArtifact={onPreviewArtifact}
                />
              ))}
            </div>
          </section>
        )}
        {externalTools && externalTools.length > 0 && (
          <section className={styles.section} aria-label="外部工具">
            <h3 className={styles.sectionHead}>
              外部工具
              <span>{externalTools.filter((tool) => tool.state === "ready").length}/{externalTools.length} 可用</span>
            </h3>
            <div className={styles.rows}>
              {externalTools.map((tool) => (
                <div className={styles.rowPlain} key={tool.serverId}>
                  <span className={styles.time}>MCP</span>
                  <span className={styles.rowMain}>
                    <span className={styles.rowTitle}>
                      <span className={styles.rowName}>{tool.label}</span>
                      <span className={styles.status} data-tone={tool.state === "ready" ? "success" : "danger"}>
                        {tool.state === "ready" ? "已连接" : "不可用"}
                      </span>
                    </span>
                    <span className={styles.rowSummaryText}>
                      {tool.tools.length > 0 ? `工具：${tool.tools.join("、")}` : "没有可用工具"}
                    </span>
                    {tool.error && <span className={styles.rowSummaryText} data-error="true">{tool.error}</span>}
                    {tool.changes.map((change) => (
                      <span className={styles.rowSummaryText} key={change}>{change}</span>
                    ))}
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}
        {!toolCalls.length && !receipts.length && (
          <div className={styles.empty}>
            <p>本任务还没有执行动作</p>
            {skills.length > 0 && (
              <ul>{skills.map((skill) => <li key={skill.id}>{skill.label}</li>)}</ul>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}

const RUN_STATUS_LABEL: Record<AgentRunStatus, string> = {
  queued: "已排队",
  running: "正在执行",
  waiting_approval: "等待授权",
  needs_attention: "需要处理",
  cancelled: "已取消",
  rejected: "已拒绝",
  uncertain: "结果不确定",
  completed: "已完成",
  failed: "失败",
};

const RISK_LABEL: Record<AgentApprovalRequest["risk"], string> = {
  low: "低风险",
  medium: "中风险",
  high: "高风险",
};

function runTone(status: AgentRunStatus): string {
  if (status === "running" || status === "waiting_approval") return "active";
  if (status === "completed") return "success";
  if (status === "needs_attention" || status === "uncertain") return "warning";
  if (status === "failed" || status === "rejected") return "danger";
  return "muted";
}

/** 契约允许 scopes 只有 once；缺省时退到最小授权范围，不擅自放大。 */
function approvalScopes(approval: AgentApprovalRequest): AgentApprovalScope[] {
  return approval.scopes.length ? approval.scopes : ["once"];
}
