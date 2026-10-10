import { useEffect, useState, type ReactNode } from 'react';
import type { AgentEvent, AgentSnapshot, AgentStage } from '../../../../shared/contracts-agent';
import { hydrateAgentStages } from '../../../../shared/agent-stage-lifecycle';
import { groupAgentTimelineEvents } from './agent-conversation-grouping';
import { AgentAssistantThread, AgentEventItem } from './agent-conversation-items';
import { renderAssistantMarkdown } from './assistant-markdown';
import styles from './agent-stage.module.less';

export function visibleAgentStages(snapshot: AgentSnapshot, events: AgentEvent[], latestPage: boolean) {
  // Legacy pages may predate stage ids. Migrate a copy without touching live state.
  let source = snapshot.stages ?? [];
  let sourceEvents = events;
  if (!source.length || events.some((event) => !event.data?.stageId)) {
    const legacy = { ...snapshot, events: events.map((event) => ({ ...event, data: { ...event.data } })), stages: undefined };
    hydrateAgentStages(legacy);
    source = legacy.stages ?? [];
    sourceEvents = legacy.events;
  }
  const groups = source.map((stage) => ({ stage, events: sourceEvents.filter((event) => event.data?.stageId === stage.id) }));
  return groups.filter((group) => group.events.length || (latestPage && group.stage === source.at(-1)));
}

function Process({ events, allEvents, userName }: { events: AgentEvent[]; allEvents: AgentEvent[]; userName: string }) {
  return <>{groupAgentTimelineEvents(events).map((item) => item.kind === 'assistant_thread'
    ? <AgentAssistantThread key={item.id} steps={item.steps} events={allEvents} leadingStatus={item.leadingStatus} expanded />
    : <AgentEventItem key={item.event.id} event={item.event} events={allEvents} userName={userName} leadingStatus={item.leadingStatus} />)}</>;
}
function Stage({ stage, events, allEvents, userName, active, finalStages, children }: {
  stage: AgentStage; events: AgentEvent[]; allEvents: AgentEvent[]; userName: string;
  active: boolean; finalStages: AgentStage[]; children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => { setOpen(false); }, [stage.status]);
  const streaming = events.some((event) => event.data?.streaming === true);
  const hasSummary = Boolean(stage.summary) && !streaming;
  const userEvents = events.filter((event) => event.type === 'user' && !event.data?.requestId);
  const processEvents = events.filter((event) => !userEvents.includes(event)
    && !(stage.decision && (event.type === 'user' || event.type === 'approval'))
    && !(hasSummary && (['input_request', 'approval_request'].includes(event.type)
      || (event.type === 'status' && ['waiting_input', 'waiting_approval', 'completed'].includes(String(event.data?.status))))));
  const final = stage.status === 'completed';
  const label = final ? '任务最终总结' : stage.status === 'waiting_approval' ? '方案完成 · 等待最终确认'
    : stage.status === 'paused' ? '执行已暂停' : stage.status === 'failed' ? '执行受阻'
      : stage.status === 'abandoned' ? '任务已废弃' : stage.status === 'superseded' ? '此前阶段已结束' : '阶段总结';
  const actions = final ? [...new Set(finalStages.filter((item) => item.runId === stage.runId).flatMap((item) => item.returnedActions))] : stage.returnedActions;
  return <section className={styles.stage} data-agent-stage={stage.id} data-stage-status={stage.status}>
    {userEvents.map((event) => <AgentEventItem key={event.id} event={event} events={allEvents} userName={userName} />)}
    {processEvents.length > 0 && (hasSummary ? <details className={styles.process} open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>查看本阶段全部过程 · {stage.eventCount} 条记录</summary>
      {events.length < stage.eventCount && <p className={styles.note}>本页显示 {events.length} 条；更早的过程可通过上方历史翻页查看。</p>}
      <div className={styles.processBody}><Process events={processEvents} allEvents={allEvents} userName={userName} /></div>
    </details> : <div className={styles.processBody}><Process events={processEvents} allEvents={allEvents} userName={userName} /></div>)}
    {hasSummary && <article className={styles.summary} data-stage-summary aria-label={label} data-final-summary={final || undefined}>
      <div className={styles.heading}><strong>{label}</strong><time dateTime={stage.updatedAt}>{new Date(stage.updatedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time></div>
      <div className={styles.prose}>{renderAssistantMarkdown(stage.summary!)}</div>
      {actions.length > 0 && <p className={styles.note}>已返回的动作：{actions.join('、')}</p>}
      {final && finalStages.some((item) => item.runId === stage.runId && item.decision) && <details className={styles.process}>
        <summary>查看历史确认记录（已处理）</summary>
        {finalStages.filter((item) => item.runId === stage.runId && item.decision).map((item) => <p key={item.id} className={styles.decisionRecord}>{item.decision}</p>)}
      </details>}
      {stage.decision && !final && <p className={styles.decisionRecord}><strong>你的决定</strong><br />{stage.decision}</p>}
      {stage.nextStep && <p className={styles.next}>{stage.nextStep}</p>}
      {active && children && <div className={styles.interaction}>{children}</div>}
    </article>}
    {!hasSummary && active && children && <div className={styles.interaction}>{children}</div>}
  </section>;
}
export function AgentStageTimeline({ snapshot, events, userName, latestPage, children }: {
  snapshot: AgentSnapshot; events: AgentEvent[]; userName: string; latestPage: boolean; children?: ReactNode;
}) {
  const groups = visibleAgentStages(snapshot, events, latestPage);
  const hasInteraction = latestPage && ((snapshot.run?.status === 'waiting_input' && snapshot.pendingInput)
    || (snapshot.run?.status === 'waiting_approval' && snapshot.pendingApproval?.status === 'pending'));
  const latestId = snapshot.stages?.at(-1)?.id ?? groups.at(-1)?.stage.id;
  return <>{groups.map(({ stage, events: stageEvents }) => <Stage key={stage.id} stage={stage} events={stageEvents}
    allEvents={events} userName={userName} finalStages={snapshot.stages ?? groups.map((group) => group.stage)}
    active={latestPage && stage.id === latestId}>{hasInteraction && stage.id === latestId ? children : undefined}</Stage>)}
    {!groups.length && hasInteraction && children}</>;
}
