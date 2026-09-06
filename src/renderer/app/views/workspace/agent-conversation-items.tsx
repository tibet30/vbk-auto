import { useEffect, useState } from "react";
import { shouldExpandAgentReasoning, splitAgentReasoning } from "../../../../shared/agent-visible-text";
import type { AgentEvent, AgentInputRequest, AgentRunStatus } from "../../../../shared/contracts";
import type { AgentThreadStep } from "./agent-conversation-grouping";
import { pairMethodBatchEvents } from "./agent-conversation-grouping";
import { renderAssistantMarkdown } from "./assistant-markdown";
import styles from "./agent-conversation.module.less";

export const STATUS: Record<AgentRunStatus, string> = {
  queued: "等待执行", running: "正在处理", waiting_input: "等待你的回答", waiting_approval: "等待最终确认",
  paused: "任务已暂停", completed: "本轮已完成", failed: "需要处理", abandoned: "任务已废弃",
};

const EVENT_LABEL: Record<AgentEvent["type"], string> = {
  user: "我", assistant: "小助手", tool_call: "执行动作", tool_result: "执行结果", status: "任务状态",
  input_request: "需要补充", approval_request: "方案待确认", approval: "确认记录",
};

export const ACTION_NAMES: Record<string, string> = {
  ask_user: "询问需要补充的信息", request_approval: "准备最终确认", resolve_itinerary_pois: "核验行程景点",
  read_product: "读取当前产品", generate_product_module: "完善产品模块", patch_product: "更新本地方案",
  query_poi: "查询景点", query_hotel_resource: "查询酒店资源", resolve_itinerary_hotels: "匹配行程酒店",
  resolve_cover: "匹配产品封面", query_vehicle_resource: "查询用车资源", resolve_vehicle_resource: "匹配用车资源",
  query_station: "查询交通站点", read_vbk_phase: "核对 VBK 结果", execute_vbk_phase: "录入 VBK 模块",
};

const MODULE_STAGE_NAMES: Record<string, string> = {
  skeleton: "产品骨架",
  basicInfo: "基础信息",
  itinerary: "每日行程",
  presentation: "产品展示",
  commercial: "套餐与价格",
  saleControl: "创建草稿",
  basic: "基础信息",
  package: "套餐",
  pricingInventory: "价格与库存",
  hotelResource: "住宿资源",
  vehicleResource: "用车资源",
  terms: "条款",
  trafficLine: "大交通",
  preflight: "整体核验",
};

function formatTime(value: string) {
  return new Date(value).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

function actionLabel(name: string) {
  return ACTION_NAMES[name] ?? name;
}

function toolCallLabel(call: AgentEvent): string {
  const name = typeof call.data?.name === "string" ? call.data.name : call.content;
  const base = actionLabel(name);
  const args = call.data?.arguments && typeof call.data.arguments === "object" && !Array.isArray(call.data.arguments)
    ? call.data.arguments as Record<string, unknown>
    : undefined;
  if (name === "query_poi") {
    const keyword = typeof args?.keyword === "string" ? args.keyword.trim() : "";
    return keyword ? `${base} · ${keyword}` : base;
  }
  if (name === "query_station") {
    const keyword = typeof args?.keyword === "string" ? args.keyword.trim() : "";
    const kindLabel = args?.kind === "airport" ? "查询机场" : args?.kind === "train" ? "查询火车站" : base;
    return keyword ? `${kindLabel} · ${keyword}` : kindLabel;
  }
  if (name === "generate_product_module") {
    const stage = typeof args?.stage === "string" ? args.stage.trim() : "";
    const stageLabel = MODULE_STAGE_NAMES[stage] ?? stage;
    return stageLabel ? `${base} · ${stageLabel}` : base;
  }
  if (name === "execute_vbk_phase") {
    const phase = typeof args?.phase === "string" ? args.phase.trim() : "";
    const phaseLabel = MODULE_STAGE_NAMES[phase] ?? phase;
    return phaseLabel ? `${base} · ${phaseLabel}` : base;
  }
  return base;
}

function answerText(event: AgentEvent, events: AgentEvent[]): string | undefined {
  const answerRequest = event.data?.requestId
    ? events.find((item) => (item.data?.request as AgentInputRequest | undefined)?.id === event.data?.requestId)?.data?.request as AgentInputRequest | undefined
    : undefined;
  const answers = event.data?.answers as Record<string, string | string[]> | undefined;
  if (!answerRequest || !answers) return undefined;
  return answerRequest.questions.map((question) => {
    const value = answers[question.id];
    const values = Array.isArray(value) ? value : [value];
    return `${question.label}：${values.filter(Boolean).map((id) => question.options?.find((option) => option.id === id)?.label ?? id).join("、") || "未填写"}`;
  }).join("\n");
}

function statusText(event: AgentEvent): string {
  return STATUS[event.content as AgentRunStatus] ?? event.content;
}

export function AgentEventItem({ event, events, leadingStatus }: { event: AgentEvent; events: AgentEvent[]; leadingStatus?: AgentEvent }) {
  if (event.type === "user") {
    return <article className={styles.message} data-role="user">
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

/** 状态/用量等内部元数据不提供“查看记录详情”，避免空提示。 */
function hasUsefulRecordDetails(event: AgentEvent, structuredResult: boolean): boolean {
  if (event.type === "status" || event.type === "approval" || event.type === "approval_request") return false;
  if (structuredResult) return true;
  if (!event.data) return false;
  const keys = Object.keys(event.data).filter((key) => !["status", "aiUsage", "modelFeedback", "streaming", "interrupted"].includes(key));
  return keys.length > 0;
}

function ThinkingActivity({ event }: { event: AgentEvent }) {
  const streaming = event.data?.streaming === true;
  const { reasoning, answer, reasoningComplete } = splitAgentReasoning(event.content);
  if (!reasoning) return null;
  const autoExpand = shouldExpandAgentReasoning({ streaming, reasoningComplete });
  const [open, setOpen] = useState(autoExpand);
  useEffect(() => { setOpen(autoExpand); }, [autoExpand, event.id]);
  const label = streaming && !reasoningComplete ? "正在思考…" : "思考片刻";
  return <details className={styles.activity} open={open} onToggle={(item) => setOpen(item.currentTarget.open)}>
    <summary>{label}</summary>
    <div className={styles.activityBody}>{reasoning}</div>
  </details>;
}

function ToolsActivity({ events, leadingStatus }: { events: AgentEvent[]; leadingStatus?: AgentEvent }) {
  const [open, setOpen] = useState(false);
  const pairs = pairMethodBatchEvents(events);
  if (!pairs.length) return null;
  const labels = pairs.map((pair) => toolCallLabel(pair.call));
  const preview = labels.slice(0, 2).join("、") + (labels.length > 2 ? " 等" : "");
  const done = pairs.filter((pair) => pair.result).length;
  const title = (leadingStatus ? `${statusText(leadingStatus)} · ` : "")
    + `已使用 ${pairs.length} 个工具` + (preview ? ` · ${preview}` : "") + (done < pairs.length ? ` · ${done}/${pairs.length}` : "");

  return <details className={styles.activity} open={open} onToggle={(item) => setOpen(item.currentTarget.open)}>
    <summary>{title}</summary>
    <div className={styles.activityBody}>
      {pairs.map((pair) => {
        const structured = !!pair.result && /^[\s]*[\[{]/.test(pair.result.content);
        return <details key={pair.call.id} className={styles.toolRow}>
          <summary>
            <span>{toolCallLabel(pair.call)}</span>
            <span className={styles.toolStatus}>{pair.result ? "已返回" : "执行中"}</span>
          </summary>
          <div className={styles.toolRowBody}>
            <div><strong>调用</strong><pre>{JSON.stringify(pair.call.data?.arguments ?? pair.call.data ?? {}, null, 2)}</pre></div>
            {pair.result && <div><strong>返回</strong><pre>{structured || pair.result.data
              ? `${pair.result.content}${pair.result.data ? `\n\n${JSON.stringify(pair.result.data, null, 2)}` : ""}`
              : pair.result.content}</pre></div>}
          </div>
        </details>;
      })}
    </div>
  </details>;
}

function AssistantAnswer({ event }: { event: AgentEvent }) {
  const streaming = event.data?.streaming === true;
  const interrupted = event.data?.interrupted === true;
  const { reasoning, answer } = splitAgentReasoning(event.content);
  const visibleAnswer = answer || (!reasoning ? event.content.trim() : "");
  if (!visibleAnswer && !interrupted) return null;
  return <div className={styles.assistantProse} data-streaming={streaming || undefined} data-interrupted={interrupted || undefined} aria-busy={streaming || undefined}>
    {visibleAnswer ? renderAssistantMarkdown(visibleAnswer) : "生成已中止"}
  </div>;
}

/** Cursor 式助手线程：思考 → 工具 → 正文。 */
export function AgentAssistantThread({ steps, leadingStatus }: { steps: AgentThreadStep[]; leadingStatus?: AgentEvent }) {
  const streaming = steps.some((step) => step.kind === "turn" && step.event.data?.streaming === true);
  const consumed = new Set<string>();
  let leadingStatusAvailable = leadingStatus;
  return <div className={styles.assistantThread} data-thread="assistant" data-streaming={streaming || undefined} aria-busy={streaming || undefined}>
    {steps.map((step, index) => {
      if (step.kind === "methods") {
        if (consumed.has(step.id)) return null;
        const start = leadingStatusAvailable;
        leadingStatusAvailable = undefined;
        return <ToolsActivity key={step.id} events={step.events} leadingStatus={start} />;
      }
      const following = steps[index + 1];
      const methods = following?.kind === "methods" ? following : undefined;
      if (methods) consumed.add(methods.id);
      const start = leadingStatusAvailable;
      leadingStatusAvailable = undefined;
      return <div key={step.event.id} className={styles.threadTurn}>
        <ThinkingActivity event={step.event} />
        {methods ? <ToolsActivity events={methods.events} leadingStatus={start} /> : null}
        <AssistantAnswer event={step.event} />
      </div>;
    })}
  </div>;
}
