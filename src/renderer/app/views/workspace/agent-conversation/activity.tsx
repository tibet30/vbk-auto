import { useEffect, useState } from "react";
import type { AgentEvent } from "../../../../../shared/contracts";
import { shouldExpandAgentReasoning, splitAgentReasoning } from "../../../../../shared/agent-visible-text";
import styles from "../agent-conversation.module.less";
import { MessageMarkdown } from "../../shared/message-markdown";
import { pairMethodBatchEvents } from "../agent-conversation-grouping";
import { statusText, toolCallLabel } from "./labels";
import { ToolResultBody } from "./tool-result-view";

/** 推理内容折叠：流式未完成时自动展开，完成后收起但保留入口。 */
export function ThinkingActivity({ event }: { event: AgentEvent }) {
  const streaming = event.data?.streaming === true;
  const { reasoning, reasoningComplete } = splitAgentReasoning(event.content);
  if (!reasoning) return null;
  const autoExpand = shouldExpandAgentReasoning({ streaming, reasoningComplete });
  const [open, setOpen] = useState(autoExpand);
  useEffect(() => { setOpen(autoExpand); }, [autoExpand, event.id]);
  const label = streaming && !reasoningComplete ? "正在思考…" : "思考片刻";
  return <details className={styles.activity} open={open} onToggle={(item) => setOpen(item.currentTarget.open)}>
    <summary>{label}</summary>
    <div className={styles.activityBody}><MessageMarkdown content={reasoning} /></div>
  </details>;
}

function toolName(call: AgentEvent): string {
  return typeof call.data?.name === "string" ? call.data.name : call.content;
}

/** 一次模型回合内的工具批：外层折叠成一行摘要，内层每条工具结果结构化渲染。 */
export function ToolsActivity({ events, resultEvents = events, leadingStatus, expanded = false }: {
  events: AgentEvent[];
  resultEvents?: AgentEvent[];
  leadingStatus?: AgentEvent;
  expanded?: boolean;
}) {
  const [open, setOpen] = useState(expanded);
  const pairs = pairMethodBatchEvents(events, resultEvents);
  if (!pairs.length) return null;
  const labels = pairs.map((pair) => toolCallLabel(pair.call));
  const preview = labels.slice(0, 2).join("、") + (labels.length > 2 ? " 等" : "");
  const done = pairs.filter((pair) => pair.result).length;
  const title = (leadingStatus ? `${statusText(leadingStatus)} · ` : "")
    + `已使用 ${pairs.length} 个工具` + (preview ? ` · ${preview}` : "") + (done < pairs.length ? ` · ${done}/${pairs.length}` : "");

  return <details className={styles.activity} data-expanded={expanded || undefined} open={open} onToggle={(item) => setOpen(item.currentTarget.open)}>
    <summary>{title}</summary>
    <div className={styles.activityBody}>
      {pairs.map((pair) => <details key={pair.call.id} className={styles.toolRow} open={expanded}>
        <summary>
          <span>{toolCallLabel(pair.call)}</span>
          <span className={styles.toolStatus}>{pair.result ? "已返回" : "执行中"}</span>
        </summary>
        <div className={styles.toolRowBody}>
          {pair.result
            ? <ToolResultBody name={toolName(pair.call)} content={pair.result.content} />
            : <div className={styles.resultEmpty}>执行中…</div>}
          <details className={styles.resultRaw}>
            <summary>调用参数</summary>
            <pre>{JSON.stringify(pair.call.data?.arguments ?? pair.call.data ?? {}, null, 2)}</pre>
          </details>
        </div>
      </details>)}
    </div>
  </details>;
}
