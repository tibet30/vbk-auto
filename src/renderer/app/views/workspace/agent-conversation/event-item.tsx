import type { AgentEvent, AgentInputRequest } from "../../../../../shared/contracts";
import styles from "../agent-conversation.module.less";
import { EVENT_LABEL, formatTime, statusText, toolCallLabel } from "./labels";

function answerText(event: AgentEvent, events: AgentEvent[]): string | undefined {
  const request = event.data?.requestId
    ? events.find((item) => (item.data?.request as AgentInputRequest | undefined)?.id === event.data?.requestId)?.data?.request as AgentInputRequest | undefined
    : undefined;
  const answers = event.data?.answers as Record<string, string | string[]> | undefined;
  if (!request || !answers) return undefined;
  return request.questions.map((question) => {
    const value = answers[question.id];
    const values = Array.isArray(value) ? value : [value];
    return `${question.label}：${values.filter(Boolean).map((id) => question.options?.find((option) => option.id === id)?.label ?? id).join("、") || "未填写"}`;
  }).join("\n");
}

/** 状态/用量等内部元数据不提供“查看记录详情”，避免空提示。 */
function hasUsefulRecordDetails(event: AgentEvent, structuredResult: boolean): boolean {
  if (event.type === "status" || event.type === "approval" || event.type === "approval_request") return false;
  if (structuredResult) return true;
  if (!event.data) return false;
  const keys = Object.keys(event.data).filter((key) => !["status", "aiUsage", "modelFeedback", "streaming", "interrupted"].includes(key));
  return keys.length > 0;
}

export function AgentEventItem({ event, events, userName, leadingStatus }: {
  event: AgentEvent;
  events: AgentEvent[];
  userName: string;
  leadingStatus?: AgentEvent;
}) {
  if (event.type === "user") {
    const avatar = userName.slice(0, 1);
    return <article className={styles.message} data-role="user" aria-label={`${userName}的消息`}>
      <span className={styles.messageIdentity} aria-hidden="true"><span className={styles.messageAvatar}>{avatar}</span></span>
      <div className={styles.messageContent}>{event.content}</div>
    </article>;
  }
  const historicalRequest = event.type === "input_request" ? event.data?.request as AgentInputRequest | undefined : undefined;
  const structuredResult = event.type === "tool_result" && /^[\s]*[\[{]/.test(event.content);
  const answered = answerText(event, events);
  const content = answered ?? (event.type === "status" ? statusText(event)
    : event.type === "tool_call" ? toolCallLabel(event)
    : event.content);
  const displayContent = leadingStatus ? `${statusText(leadingStatus)} · ${content}` : content;
  return <article className={styles.systemNote} data-type={event.type}>
    <div className={styles.meta}><strong>{EVENT_LABEL[event.type]}</strong><time dateTime={event.createdAt}>{formatTime(event.createdAt)}</time></div>
    <div className={styles.messageContent}>{displayContent}</div>
    {historicalRequest?.questions && <ol>{historicalRequest.questions.map((question) => <li key={question.id}>{question.label}{question.options?.length ? `（${question.options.map((option) => option.label).join(" / ")}）` : ""}</li>)}</ol>}
    {hasUsefulRecordDetails(event, structuredResult) && <details className={styles.details}><summary>查看调用详情</summary><pre>{structuredResult ? `${event.content}\n\n${JSON.stringify(event.data, null, 2)}` : JSON.stringify(event.data, null, 2)}</pre></details>}
  </article>;
}
