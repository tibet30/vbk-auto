import type { AutomationRun, ProductDetail } from '../../../shared/contracts.js';
import { parseProduct } from '../schema/schema.js';
import { draftPhasesFor } from './automation.main.phases.js';

/** Fresh Agent run keeps historical stage evidence but never borrows completion. */
export function prepareAgentAutomation(product: ProductDetail, agentRunId: string, phase: string): AutomationRun {
  const phases = draftPhasesFor(parseProduct(product.product));
  if (phase !== 'saleControl' && !phases.includes(phase)) throw new Error(`当前产品不支持阶段：${phase}`);
  const runId = `agent:${agentRunId}`;
  if (product.automation?.id === runId) return normaliseSavedBasicPhase(product.automation, product.basicInfoSaved === true);
  return {
    id:runId,status:'queued',phases:phases.map(name=>({phase:name,status:name === 'basic' && product.basicInfoSaved ? 'completed' : 'pending'})),logs:[],
    ...(product.automation?.trafficLine ? {trafficLine:product.automation.trafficLine}:{}),
  };
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
