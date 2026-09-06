import type { AgentSnapshot, ProductWorkflowTask } from '../../shared/contracts.js';
import { logWarn } from '../../shared/log-timestamp.js';
import { approvalForRun } from './integration-gates.js';

export function agentWorkflowPatch(snapshot: AgentSnapshot): Partial<ProductWorkflowTask> {
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
  const progress = status==='succeeded' ? 100 : scopes.length ? Math.min(99, Math.round(scopes.filter(scope=>done.has(scope)).length/scopes.length*100)) : 0;
  const message = snapshot.pendingApproval?.summary ?? (snapshot.pendingInput ? '等待补充信息'
    : run?.error ?? (status==='succeeded' ? '本轮任务已完成' : status==='abandoned' ? '任务已放弃'
      : run?.status==='paused' ? '任务已暂停，可继续处理' : 'Agent 正在处理产品'));
  return {status,stage,progress,message,error:run?.error,
    completedAt:['succeeded','abandoned','failed'].includes(status) ? run?.updatedAt : undefined};
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
