import type { AgentSnapshot, ProductDetail, ProductWorkflowTask } from '../../shared/contracts.js';
import { logWarn } from '../../shared/log-timestamp.js';
import { approvalForRun } from './integration-gates.js';

export function agentWorkflowPatch(snapshot: AgentSnapshot, product?: ProductDetail): Partial<ProductWorkflowTask> {
  const run = snapshot.run;
  const status: ProductWorkflowTask['status'] = run?.status === 'completed' ? 'succeeded'
    : run?.status === 'failed' ? 'failed'
    : run?.status === 'abandoned' ? 'abandoned'
    : ['waiting_input','waiting_approval','paused'].includes(run?.status ?? '') ? 'needs_attention'
    : run?.status === 'queued' ? 'queued' : 'running';
  const approval = approvalForRun(snapshot);
  const stage = status==='succeeded' ? 'completed' : approval ? 'automation'
    : snapshot.pendingApproval ? 'readiness' : status==='queued' ? 'queued' : 'planning';
  const scopes = approval?.scope ?? [];
  const done = new Set(snapshot.events.filter(event=>event.runId===run?.id && event.type==='tool_result'
    && event.data?.verified===true).map(event=>`vbk.write_phase:${event.data?.phase}`));
  // 确定性录入执行器的完成证据写在 automation.phases（无 tool_result 事件）；
  // 不并入的话，携程录入阶段会一直停在 0%。
  for (const phase of product?.automation?.phases ?? []) {
    if (phase.status === 'completed') done.add(`vbk.write_phase:${phase.phase}`);
  }
  const progress = workflowProgress(status, snapshot, scopes, done);
  const message = snapshot.pendingApproval ? '方案已就绪，等待授权录入'
    : snapshot.pendingInput ? '等待补充信息'
      : run?.error ?? (status==='succeeded' ? '本轮任务已完成' : status==='abandoned' ? '任务已放弃'
        : run?.status==='paused' ? '任务已暂停，可继续处理' : 'Agent 正在处理产品');
  return {status,stage,progress,message,error:run?.error,
    completedAt:['succeeded','abandoned','failed'].includes(status) ? run?.updatedAt : undefined};
}

const GENERATE_STAGES = ["skeleton", "basicInfo", "itinerary", "presentation", "commercial"] as const;
type GenerateStage = (typeof GENERATE_STAGES)[number];
const GENERATION_STAGE_PROGRESS: Record<GenerateStage, number> = {
  skeleton: 10, basicInfo: 18, itinerary: 28, presentation: 36, commercial: 45,
};
const PLANNING_STARTED_PROGRESS = 5;
const PLANNING_AWAITING_APPROVAL_PROGRESS = 50;

function workflowProgress(
  status: ProductWorkflowTask['status'],
  snapshot: AgentSnapshot,
  scopes: string[],
  done: Set<string>,
): number {
  if (status === 'succeeded') return 100;
  const planning = planningProgress(snapshot, status);
  if (!scopes.length) return planning;
  const entry = Math.min(99, Math.round(scopes.filter((scope) => done.has(scope)).length / scopes.length * 100));
  if (status === 'failed' || status === 'abandoned') return entry;
  return Math.max(planning, entry || PLANNING_AWAITING_APPROVAL_PROGRESS);
}

/** generate_product_module 完成证据只在当前 run 事件里；ProductDetail.planning 没有阶段完成列表。 */
function planningProgress(snapshot: AgentSnapshot, status: ProductWorkflowTask['status']): number {
  if (snapshot.pendingApproval) return PLANNING_AWAITING_APPROVAL_PROGRESS;
  const runId = snapshot.run?.id;
  if (!runId) return 0;
  const completed = completedGenerateStages(snapshot, runId);
  let progress = status === 'running' || status === 'queued' ? PLANNING_STARTED_PROGRESS : 0;
  for (const stage of GENERATE_STAGES) {
    if (completed.has(stage)) progress = Math.max(progress, GENERATION_STAGE_PROGRESS[stage]);
  }
  return progress;
}

function completedGenerateStages(snapshot: AgentSnapshot, runId: string): Set<GenerateStage> {
  const stageByCall = new Map<string, GenerateStage>();
  for (const event of snapshot.events) {
    if (event.runId !== runId || event.type !== 'tool_call' || event.data?.name !== 'generate_product_module') continue;
    const stage = asGenerateStage(event.data.arguments);
    if (stage) stageByCall.set(String(event.data.toolCallId ?? ''), stage);
  }
  const completed = new Set<GenerateStage>();
  for (const event of snapshot.events) {
    if (event.runId !== runId || event.type !== 'tool_result' || event.data?.error) continue;
    const stage = stageByCall.get(String(event.data?.toolCallId ?? ''));
    if (stage) completed.add(stage);
  }
  return completed;
}

function asGenerateStage(args: unknown): GenerateStage | undefined {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return undefined;
  const stage = Reflect.get(args, 'stage');
  return GENERATE_STAGES.find((item) => item === stage);
}

export interface RecoverQueuedAgentWorkflowTasksInput {
  listWorkflowTasks(): ProductWorkflowTask[];
  updateWorkflowTask(id: string, patch: Partial<ProductWorkflowTask>): ProductWorkflowTask;
  getAgentSnapshot(localProductId: string): Promise<AgentSnapshot>;
  resumeAgent(localProductId: string): Promise<AgentSnapshot>;
  emitWorkflowTask(task: ProductWorkflowTask): void;
}

/**
 * After startup, queued workflow rows are either (a) Agent runs that should
 * continue, or (b) orphans left when createWorkflowTask raced ahead of the
 * first Agent snapshot. Never route them through the retired one-click scheduler.
 */
export async function recoverQueuedAgentWorkflowTasks(
  input: RecoverQueuedAgentWorkflowTasksInput,
): Promise<{ resumed: number; attention: number }> {
  let resumed = 0;
  let attention = 0;
  for (const task of input.listWorkflowTasks()) {
    if (task.status !== "queued") continue;
    try {
      const snapshot = await input.getAgentSnapshot(task.localProductId);
      const run = snapshot.run;
      if (!run || run.status === "completed" || run.status === "abandoned") {
        input.emitWorkflowTask(input.updateWorkflowTask(task.id, {
          status: "needs_attention",
          message: "任务在启动前中断，请在方案协作中继续",
          error: "后台一键调度已停用；请打开产品在方案协作中继续处理。",
          completedAt: undefined,
        }));
        attention += 1;
        continue;
      }
      if (run.status === "queued" || run.status === "running") {
        await input.resumeAgent(task.localProductId);
        resumed += 1;
        continue;
      }
      // waiting_input / waiting_approval / paused / failed: get() already
      // persisted the checkpoint; leave the synced needs_attention/failed row.
    } catch (error) {
      logWarn("[startup] failed to recover queued agent workflow task", {
        taskId: task.id,
        localProductId: task.localProductId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { resumed, attention };
}
