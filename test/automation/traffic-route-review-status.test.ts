import test from 'node:test';
import assert from 'node:assert/strict';
import { isTrafficLineRouteReviewRequired, isUnavailableTrafficResourceFailure } from '../../src/shared/traffic-resource-status.js';

test('玩法线路审核前置条件必须保留为未完成，不能伪装成无可售资源', () => {
  const reason = '设置飞机往返子产品套餐有效失败（Ack=Failure）：当前产品未匹配玩法线路，请去行程描述/资源配置页面提交审核匹配线路';
  assert.equal(isTrafficLineRouteReviewRequired(reason), true);
  for (const variant of ['flightRoundTrip', 'trainRoundTrip'] as const) assert.equal(isUnavailableTrafficResourceFailure(reason, variant), false);
  assert.equal(isTrafficLineRouteReviewRequired('当前无可售资源'), false);
});

test('母草稿通过预检但交通待线路审核时，Agent 明确给出前置步骤而不是让用户盲目重试', async () => {
  const { buildProductSnapshot } = await import('../../src/main/infrastructure/database/parts/product-draft.js');
  const { agentProductVersion, buildAgentApproval, agentCompletionGate } = await import('../../src/main/agent/integration-gates.js');
  const p = buildProductSnapshot({ destination: '西安', days: 6, productForm: 'privateTour' });
  p.productId = '79346484'; p.status = 'draft_saved';
  (p.product.operations as any).trafficLine = { enabled: true, variants: ['flightRoundTrip'] };
  const approval = { id: 'approval', ...buildAgentApproval(p), productVersion: agentProductVersion(p), intentVersion: 'intent', accountKey: 'account', status: 'approved', createdAt: 'now' };
  p.automation = { status: 'succeeded', phases: [{ phase: 'trafficLine', status: 'completed' }, { phase: 'preflight', status: 'completed' }], trafficLine: { children: [{ variant: 'flightRoundTrip', childProductId: '79357948', completedStages: ['clausesSaved'], verified: false, failedStage: 'activated', failureReason: '当前产品未匹配玩法线路，请去行程描述/资源配置页面提交审核匹配线路' }] } } as any;
  const result = agentCompletionGate(p, { localProductId: p.id, run: { id: 'run', intentVersion: 'intent' }, events: [{ type: 'approval', runId: 'run', data: { approval } }] } as any, { ready: true, issues: [], completion: 100 }, { hadRemoteWrites: true, deterministicWorkflow: true, runId: 'run' } as any);
  assert.equal(result.verified, false);
  assert.match(result.message!, /母产品 79346484 草稿已保存/);
  assert.match(result.message!, /提交玩法线路匹配审核/);
  assert.match(result.message!, /审核通过后从 activated 继续/);
});

test('产品列表显示线路审核前置条件，保留待处理状态与非100%进度', async () => {
  const { agentWorkflowPatch } = await import('../../src/main/agent/integration-workflow.js');
  const patch = agentWorkflowPatch({ run: { id: 'run', status: 'paused' }, events: [] } as any, {
    status: 'draft_saved', productId: '79346484', product: {}, automation: { trafficLine: { children: [{ verified: false, failureReason: '当前产品未匹配玩法线路' }] } },
  } as any);
  assert.equal(patch.status, 'needs_attention');
  assert.match(patch.message!, /母产品草稿已保存；交通套餐待玩法线路匹配审核/);
  assert.ok(patch.progress! < 100);
});
