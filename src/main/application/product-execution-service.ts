import type { AgentSnapshot, ProductDetail, ProductWorkflowTask } from '../../shared/contracts.js';
import type { ProductExecutionView } from '../../shared/contracts-product-architecture.js';
import { approvalForRun } from '../agent/integration-gates.js';
import { agentWorkflowPatch } from '../agent/integration-workflow.js';
import { hasVerifiedMotherPhases, failedAutomationResumePhase, approvedRecoveryStartPhase } from '../automation/automation.main/automation.main.resume-phase.js';
import { blockingTrafficVariants, isUnavailableTrafficResourceFailure, trafficChildSkipHandled } from '../../shared/traffic-resource-status.js';
import { trafficSummaryMessage } from './traffic-summary-message.js';
import type { TrafficLineConfig } from '../../shared/contracts-traffic-line.js';

export { trafficSummaryMessage };

export interface ProductExecutionStore {
  listWorkflowTasks?(): ProductWorkflowTask[];
  getProduct(id: string): ProductDetail | undefined;
  getAgentSnapshot(id: string): AgentSnapshot | undefined;
  latestWorkflowTaskForProduct(id: string): ProductWorkflowTask | undefined;
  createWorkflowTask(id: string, name: string): ProductWorkflowTask;
  updateWorkflowTask(id: string, patch: Partial<ProductWorkflowTask>): ProductWorkflowTask;
}

export function productExecutionView(product: ProductDetail, snapshot?: AgentSnapshot, task?: ProductWorkflowTask): ProductExecutionView {
  const verified = hasVerifiedMother(product);
  const children = product.automation?.trafficLine?.children ?? [];
  const phase = product.automation?.currentPhase;
  const pendingTraffic = hasPendingTraffic(product, snapshot);
  const run = snapshot?.run;
  const nextAction: ProductExecutionView['nextAction'] = task?.status === 'abandoned' || run?.status === 'abandoned' ? 'none'
    : snapshot?.uncertainWrite ? 'verify_write'
    : run?.status === 'waiting_input' ? 'provide_input'
    : run?.status === 'waiting_approval' ? 'approve'
    : run?.status === 'queued' || run?.status === 'running' ? 'wait'
    : run?.status === 'paused' || run?.status === 'failed' || !verified || pendingTraffic ? 'resume' : 'none';
  return {
    stage: phase ?? task?.stage ?? 'planning',
    pauseReason: snapshot?.uncertainWrite?.message ?? run?.error ?? task?.error,
    nextAction,
    resumePhase: nextAction === 'resume' ? approvedRecoveryStartPhase(product, failedAutomationResumePhase(product.automation)) : undefined,
    mother: verified ? 'verified' : 'pending',
    children: children.map(child => ({ id: String(child.childProductId ?? child.variant),
      verified: child.verified === true && (child.completedStages ?? []).includes('finalReadback'), reason: child.failureReason })),
    task,
  };
}

function hasVerifiedMother(product: ProductDetail): boolean {
  try { return hasVerifiedMotherPhases(product); } catch { return false; }
}

function hasPendingTraffic(product: ProductDetail, snapshot?: AgentSnapshot): boolean {
  const approval = approvalForRun(snapshot);
  if (approval && approval.generateTrafficChildren !== true) return false;
  const config = (product.product.operations as { trafficLine?: TrafficLineConfig } | undefined)?.trafficLine;
  const children = product.automation?.trafficLine?.children ?? [];
  return blockingTrafficVariants(config, product.automation?.trafficLine).length > 0
    || children.some(child => !(child.verified && (child.completedStages ?? []).includes('finalReadback')) && !trafficChildSkipHandled(child)
      && !isUnavailableTrafficResourceFailure(child.failureReason ?? '', child.variant));
}

/** The only application policy translating durable execution facts into task state. */
export class ProductExecutionService {
  constructor(private readonly store: ProductExecutionStore) {}
  read(id: string): ProductExecutionView {
    const product = this.store.getProduct(id);
    if (!product) throw new Error('产品不存在');
    return productExecutionView(product, this.store.getAgentSnapshot(id), this.store.latestWorkflowTaskForProduct(id));
  }
  recoverInterrupted(): ProductWorkflowTask[] {
    return (this.store.listWorkflowTasks?.() ?? []).filter(task => task.status === 'running'
      || (task.status === 'needs_attention' && task.error === '任务因应用退出而中断'))
      .map(task => this.store.updateWorkflowTask(task.id, { status: 'queued',
        message: '任务因应用退出而中断，将在启动后继续', error: undefined, completedAt: undefined }));
  }
  reconcile(id: string): ProductWorkflowTask | undefined {
    const product = this.store.getProduct(id);
    if (!product) return undefined;
    const snapshot = this.store.getAgentSnapshot(id);
    let task = this.store.latestWorkflowTaskForProduct(id);
    if (snapshot?.run && (!task || (['succeeded', 'failed', 'abandoned', 'cancelled'].includes(task.status)
      && snapshot.run.createdAt > task.updatedAt))) task = this.store.createWorkflowTask(id, product.name);
    if (!task || task.status === 'abandoned') return task;
    if (snapshot?.run?.status === 'abandoned') {
      return this.store.updateWorkflowTask(task.id, agentWorkflowPatch(snapshot, product));
    }
    const view = productExecutionView(product, snapshot, task);
    let patch = snapshot?.run ? agentWorkflowPatch(snapshot, product) : {};
    const pending = hasPendingTraffic(product, snapshot);
    if (snapshot?.uncertainWrite) {
      patch = { ...patch, status: 'needs_attention', progress: Math.min(task.progress, 99),
        message: '平台写入结果不明，请先核查回读', error: snapshot.uncertainWrite.message, completedAt: undefined };
    } else if (view.mother === 'verified' && !pending) {
      patch = { ...patch, status: 'succeeded', stage: 'completed', progress: 100,
        message: trafficSummaryMessage(product, snapshot), error: undefined,
        completedAt: task.completedAt ?? snapshot?.run?.updatedAt ?? product.updatedAt };
    } else if (view.mother === 'verified' && pending) {
      patch = { ...patch, status: snapshot?.run?.status === 'running' ? 'running' : 'needs_attention',
        stage: 'automation', progress: Math.min(patch.progress ?? task.progress, 99),
        message: '母产品草稿已保存；交通套餐尚未通过最终回读，处理后继续', completedAt: undefined };
    } else if (patch.status === 'succeeded' || task.status === 'succeeded') {
      patch = { ...patch, status: 'needs_attention', progress: Math.min(task.progress, 99),
        message: '产品尚未通过阶段完成核验', completedAt: undefined };
    }
    if (!Object.keys(patch).length || Object.entries(patch).every(([key, value]) => task![key as keyof ProductWorkflowTask] === value)) return task;
    return this.store.updateWorkflowTask(task.id, patch);
  }
}
