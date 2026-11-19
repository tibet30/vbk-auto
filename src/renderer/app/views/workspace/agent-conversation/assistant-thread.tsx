import type { AgentEvent } from "../../../../../shared/contracts";
import { splitAgentReasoning } from "../../../../../shared/agent-visible-text";
import styles from "../agent-conversation.module.less";
import { MessageMarkdown } from "../../shared/message-markdown";
import type { AgentThreadStep } from "../agent-conversation-grouping";
import { statusText } from "./labels";
import { ThinkingActivity, ToolsActivity } from "./activity";

function AssistantAnswer({ event }: { event: AgentEvent }) {
  const streaming = event.data?.streaming === true;
  const interrupted = event.data?.interrupted === true;
  const { reasoning, answer } = splitAgentReasoning(event.content);
  const visibleAnswer = answer || (!reasoning ? event.content.trim() : "");
  if (!visibleAnswer && !interrupted) return null;
  return <div className={styles.assistantProse} data-streaming={streaming || undefined} data-interrupted={interrupted || undefined} aria-busy={streaming || undefined}>
    {visibleAnswer ? <MessageMarkdown content={visibleAnswer} streaming={streaming} /> : "生成已中止"}
  </div>;
}

function AssistantIdentity() {
  return <span className={styles.assistantIdentity} aria-hidden="true"><span className={styles.assistantAvatar}>AI</span></span>;
}

/** Cursor 式助手线程：思考 → 正文 → 工具。 */
export function AgentAssistantThread({ steps, events, leadingStatus, expanded = false }: {
  steps: AgentThreadStep[];
  events: AgentEvent[];
  leadingStatus?: AgentEvent;
  expanded?: boolean;
}) {
  const streaming = steps.some((step) => step.kind === "turn" && step.event.data?.streaming === true);
  const consumed = new Set<string>();
  let leadingStatusAvailable = leadingStatus;
  return <div className={styles.assistantThread} data-thread="assistant" data-streaming={streaming || undefined} aria-label="AI 的消息" aria-busy={streaming || undefined}>
    {steps.map((step, index) => {
      if (step.kind === "methods") {
        if (consumed.has(step.id)) return null;
        const start = leadingStatusAvailable;
        leadingStatusAvailable = undefined;
        return <div key={step.id} className={styles.threadTurn}>
          <AssistantIdentity />
          <ToolsActivity events={step.events} resultEvents={events} leadingStatus={start} expanded={expanded} />
        </div>;
      }
      const following = steps[index + 1];
      const methods = following?.kind === "methods" ? following : undefined;
      if (methods) consumed.add(methods.id);
      const start = leadingStatusAvailable;
      leadingStatusAvailable = undefined;
      return <div key={step.event.id} className={styles.threadTurn}>
        <AssistantIdentity />
        <ThinkingActivity event={step.event} />
        <AssistantAnswer event={step.event} />
        {methods ? <ToolsActivity events={methods.events} resultEvents={events} leadingStatus={start} expanded={expanded} /> : null}
      </div>;
    })}
  </div>;
}
