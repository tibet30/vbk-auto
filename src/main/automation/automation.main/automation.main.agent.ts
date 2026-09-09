import type { AutomationRun, ProductDetail } from '../../../shared/contracts.js';
import { parseProduct } from '../schema/schema.js';
import { draftPhasesFor } from './automation.main.phases.js';

/**
 * 新确认通常从新的 Agent run 开始，不能默认借用历史完成态；但续办例外：
 * 同一 Agent run 的再次确认，或「目标阶段失败」的受限恢复，必须保留此前已经
 * resultVerified 的阶段。这样修复目标阶段后继续 preflight 时，也不会回写产品展示、
 * 行程、套餐等无关内容。
 */
export function prepareAgentAutomation(product: ProductDetail, agentRunId: string, phase: string): AutomationRun {
  const phases = draftPhasesFor(parseProduct(product.product));
  if (phase !== 'saleControl' && !phases.includes(phase)) throw new Error(`当前产品不支持阶段：${phase}`);
  const runId = `agent:${agentRunId}`;
  const existing = product.automation;
  if (existing?.id === runId || isFailedPhaseRecovery(existing, phase) || isSameAgentRun(existing, runId)) {
    return normaliseSavedBasicPhase(existing, product.basicInfoSaved === true);
  }
  return {
    id:runId,status:'queued',phases:phases.map(name=>({phase:name,status:name === 'basic' && product.basicInfoSaved ? 'completed' : 'pending'})),logs:[],
    ...(product.automation?.trafficLine ? {trafficLine:product.automation.trafficLine}:{}),
  };
}


function isFailedPhaseRecovery(run: AutomationRun | undefined, phase: string): run is AutomationRun {
  return run?.status === 'failed'
    && run.phases.some((item) => item.phase === phase && item.status === 'failed');
}

/** 同一 Agent 任务因补充确认而换 approvalId 时，须从耐久阶段续办，不能重跑已验证阶段。 */
function isSameAgentRun(run: AutomationRun | undefined, requestedRunId: string): run is AutomationRun {
  const existingScope = agentRunScope(run?.id ?? '');
  return existingScope !== undefined && existingScope === agentRunScope(requestedRunId);
}

function agentRunScope(runId: string): string | undefined {
  if (!runId.startsWith('agent:')) return undefined;
  const approvalSeparator = runId.lastIndexOf(':');
  return approvalSeparator > 'agent:'.length ? runId.slice(0, approvalSeparator) : undefined;
}

/** basicInfoSaved 已是远端回读后的耐久事实；Agent 重启不能再把它降回待执行。 */
function normaliseSavedBasicPhase(run: AutomationRun, basicInfoSaved: boolean): AutomationRun {
  if (!basicInfoSaved) return run;
  const basic = run.phases.find((item) => item.phase === 'basic');
  if (basic?.status === 'completed') return run;
  return {
    ...run,
    status: run.status === 'failed' ? 'queued' : run.status,
    currentPhase: run.currentPhase === 'basic' ? undefined : run.currentPhase,
    phases: run.phases.map((item) => item.phase === 'basic' ? { ...item, status: 'completed' } : item),
  };
}
