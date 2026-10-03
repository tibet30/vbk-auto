import type { AgentApproval, AgentEvent, AgentInputRequest, AgentSnapshot, AgentStage } from './contracts-agent.js';
import { stripAgentReasoning } from './agent-visible-text.js';
import { failedAgentToolResult, hasUnresolvedAgentToolFailure, UNRESOLVED_TOOL_SUMMARY } from './agent-tool-outcomes.js';

const ACTIONS: Record<string, string> = {
  read_product: '读取产品方案', query_poi: '查询景点', resolve_itinerary_pois: '核验行程景点',
  query_hotel_resource: '查询酒店资源', resolve_itinerary_hotels: '匹配酒店',
  query_vehicle_resource: '查询用车资源', resolve_vehicle_resource: '匹配用车',
  generate_product_module: '完善产品模块', patch_product: '更新本地方案',
  resolve_cover: '匹配产品封面', ensure_presentation_recommendations: '核验推荐理由',
  query_station: '查询交通站点', read_vbk_phase: '回读 VBK 模块', execute_vbk_phase: '录入 VBK 模块',
};
const CHECKPOINTS = new Set(['waiting_input', 'waiting_approval', 'completed', 'paused', 'failed', 'abandoned']);
const ENDED = new Set(['resolved', 'completed', 'superseded', 'abandoned']);

function request(event: AgentEvent): AgentInputRequest | undefined {
  return event.data?.request as AgentInputRequest | undefined;
}
function approval(event: AgentEvent): AgentApproval | undefined {
  return event.data?.approval as AgentApproval | undefined;
}
function lastStage(snapshot: AgentSnapshot, runId: string) {
  return snapshot.stages?.slice().reverse().find((stage) => stage.runId === runId);
}
function start(snapshot: AgentSnapshot, event: AgentEvent): AgentStage {
  const stage: AgentStage = {
    id: `stage-${event.id}`, runId: event.runId, status: 'running',
    startedAt: event.createdAt, updatedAt: event.createdAt, eventCount: 0, returnedActions: [],
  };
  (snapshot.stages ??= []).push(stage);
  return stage;
}
function answer(snapshot: AgentSnapshot, event: AgentEvent): string {
  const input = snapshot.events.find((item) => request(item)?.id === event.data?.requestId);
  const answers = event.data?.answers as Record<string, string | string[]> | undefined;
  if (!request(input ?? event)?.questions || !answers) return event.content;
  return request(input!)!.questions.map((question) => {
    const value = answers[question.id];
    const values = Array.isArray(value) ? value : value ? [value] : [];
    return `${question.label}：${values.map((id) => question.options?.find((option) => option.id === id)?.label ?? id).join('、') || '未填写'}`;
  }).join('\n');
}
function checkpointSummary(snapshot: AgentSnapshot, stage: AgentStage, event: AgentEvent): string {
  if (stage.status === 'waiting_input') {
    const input = [...snapshot.events].reverse().find((item) => request(item)?.id === stage.requestId);
    const summary = input?.data?.stageSummary;
    return typeof summary === 'string' && summary.trim() ? summary.trim() : '需要你补充以下信息，才能继续处理当前请求。';
  }
  if (stage.status === 'waiting_approval') {
    const approved = [...snapshot.events].reverse().find((item) => approval(item)?.id === stage.approvalId);
    return approved?.content || '方案已准备好，请核对产品后确认录入范围。';
  }
  if (stage.status !== 'completed') return event.content;
  const records = snapshot.events.slice(0, snapshot.events.findIndex((item) => item.id === event.id) + 1);
  // Only complete, non-tool replies are candidates. Never turn an execution preamble into an outcome.
  const finalReply = [...records].reverse().find((item) => item.runId === stage.runId && item.type === 'assistant'
    && item.data?.streaming !== true && item.data?.interrupted !== true && item.data?.generatedToolPreamble !== true
    && !records.some((call) => call.type === 'tool_call' && call.data?.modelTurnId
      && call.data.modelTurnId === item.data?.modelTurnId));
  const verifiedWorkflow = records.some((item) => item.runId === stage.runId
    && item.type === 'status' && item.data?.deterministicWorkflow === true && /最终回读/.test(item.content));
  if (hasUnresolvedAgentToolFailure(records, stage.runId)) return UNRESOLVED_TOOL_SUMMARY;
  if (verifiedWorkflow) return '已按本次授权完成 VBK 录入并通过最终回读。产品已保存，请在 VBK 检查草稿并手动发布。';
  const terminalResult = [...records].reverse().find((item) => item.runId === stage.runId
    && item.type === 'tool_result' && item.data?.terminal === true && !failedAgentToolResult(item));
  return terminalResult?.content || stripAgentReasoning(finalReply?.content ?? '').trim() || '本次请求已处理完成，请核对本次成果。';
}

/** Called at the event persistence junction, not inferred from prose by the UI. */
export function recordAgentStageEvent(snapshot: AgentSnapshot, event: AgentEvent): void {
  if (!event.runId) return;
  snapshot.stages ??= [];
  const call = typeof event.data?.toolCallId === 'string'
    ? snapshot.events.find((item) => item.type === 'tool_call' && item.data?.toolCallId === event.data?.toolCallId && item.runId === event.runId)
    : undefined;
  const linkedStageId = call?.data?.stageId ?? event.data?.stageId;
  let stage = typeof linkedStageId === 'string' ? snapshot.stages.find((item) => item.id === linkedStageId) : undefined;
  if (!stage) stage = lastStage(snapshot, event.runId);
  const newUserRequest = event.type === 'user' && !event.data?.requestId && !event.data?.pendingApprovalRetained
    && !event.data?.approvalPreservingRecovery;
  const continuesCheckpoint = event.type === 'status' && event.data?.status === 'running'
    && stage && ['waiting_input', 'waiting_approval', 'resolved'].includes(stage.status);
  if (newUserRequest && stage && !ENDED.has(stage.status)) {
    stage.status = 'superseded'; stage.summary = '已由你的新要求替代，此前过程与结果保留。'; stage.updatedAt = event.createdAt;
  }
  if (!stage || newUserRequest || continuesCheckpoint || (ENDED.has(stage.status) && !linkedStageId
    && !['tool_result', 'approval'].includes(event.type))) stage = start(snapshot, event);
  event.data = { ...event.data, stageId: stage.id };
  stage.eventCount += 1; stage.updatedAt = event.createdAt;
  if (event.type === 'input_request') stage.requestId = request(event)?.id;
  if (event.type === 'approval_request') stage.approvalId = approval(event)?.id;
  if (event.type === 'user' && stage.requestId && event.data.requestId === stage.requestId) {
    stage.decision = answer(snapshot, event); stage.status = 'resolved'; stage.nextStep = '已记录你的决定，继续处理后续事项。';
  }
  if (event.type === 'approval' && stage.approvalId && approval(event)?.id === stage.approvalId) {
    stage.decision = event.content;
    stage.status = approval(event)?.status === 'approved' ? 'resolved' : 'superseded';
    if (stage.status === 'superseded') { stage.summary = event.content; stage.nextStep = '原确认已失效，需要重新核验方案。'; }
  }
  if (event.type === 'tool_result' && call && !event.data.error && !event.data.cancelled
    && !event.data.uncertainWrite && !event.data.preparationDenied) {
    const name = String(call.data?.name ?? call.content);
    if (ACTIONS[name]) {
      const label = ACTIONS[name]!;
      if (!stage.returnedActions.includes(label)) stage.returnedActions.push(label);
    }
  }
  const status = event.type === 'status' ? String(event.data.status ?? '') : '';
  if (CHECKPOINTS.has(status) && !ENDED.has(stage.status)) {
    stage.status = status as AgentStage['status'];
    stage.summary = checkpointSummary(snapshot, stage, event);
    stage.nextStep = status === 'waiting_input' ? '提交决定后，我会根据你的选择继续完善。'
      : status === 'waiting_approval' ? '确认账号、方案版本和录入范围后，开始保存 VBK 草稿。'
        : status === 'completed' ? '可以核对本次成果，或提出新的调整要求。'
          : status === 'abandoned' ? '本任务不再继续，已有记录保留。' : '处理受阻原因后，可从安全检查点继续。';
  } else if (status === 'running' && ['paused', 'failed', 'queued'].includes(stage.status)) {
    stage.status = 'running'; stage.summary = undefined; stage.nextStep = undefined;
  }
}

/** Stable legacy migration: only typed interaction/status boundaries create stages. */
export function hydrateAgentStages(snapshot: AgentSnapshot): void {
  if (snapshot.stages !== undefined) {
    // Usage and reconciliation can append outside the model loop. Associate
    // those records without recreating already persisted checkpoints.
    let previous: AgentEvent | undefined;
    for (const event of snapshot.events) {
      if (!event.data?.stageId) {
        if (previous?.runId === event.runId && previous.data?.stageId) event.data = { ...event.data, stageId: previous.data.stageId };
        recordAgentStageEvent(snapshot, event);
      }
      previous = event;
    }
    return;
  }
  snapshot.stages = [];
  for (const event of snapshot.events) recordAgentStageEvent(snapshot, event);
  const current = snapshot.run && lastStage(snapshot, snapshot.run.id);
  if (current) {
    current.requestId ??= snapshot.pendingInput?.id;
    current.approvalId ??= snapshot.pendingApproval?.id;
    if (current.status === 'waiting_approval' && snapshot.pendingApproval) current.summary = snapshot.pendingApproval.summary;
  }
  if (current && current.status !== snapshot.run!.status && !ENDED.has(current.status)) {
    current.status = snapshot.run!.status;
    if (CHECKPOINTS.has(current.status)) current.summary ??= checkpointSummary(snapshot, current, {
      id: 'legacy-status', runId: current.runId, type: 'status', createdAt: current.updatedAt,
      content: snapshot.run!.error ?? '执行过程已保留。', data: { status: current.status },
    });
  }
}
