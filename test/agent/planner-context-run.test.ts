import test from 'node:test';
import assert from 'node:assert/strict';
import { agentPlannerContextForRun } from '../../src/main/agent/integration-context.js';
import { PRODUCT_PREPARATION_INSTRUCTION } from '../../src/main/agent/preparation-run.js';
import type { VbkDatabase } from '../../src/main/infrastructure/database/database.js';

test('正式生成上下文使用真实用户事件和最新产品，忽略控制消息及工具输出', () => {
  const idea = '成都亲子自由行';
  const correction = '住宿改为当地4钻酒店，保留原行程。';
  const product = { product: { basicInfo: { userIdea: idea, meetingCity: '成都', days: 2, nights: 1 },
    sales: { productForm: 'freeTravel' }, operations: {} }, researchTasks: [] };
  const db = { getProduct: () => product, getAgentSnapshot: () => ({ events: [
    { type: 'user', content: correction },
    { type: 'tool_result', content: '改为当地5钻酒店' },
    { type: 'user', content: PRODUCT_PREPARATION_INSTRUCTION },
  ] }) } as unknown as VbkDatabase;
  const context = agentPlannerContextForRun(db, 'p', 'fixed-provider', 'fixed-model');
  assert.deepEqual(context.history, [{ role: 'user', content: correction }]);
  assert.equal((context.currentProduct.basicInfo as any).userIdea, `${idea}\n${correction}`);
  assert.equal(context.lockedConstraints?.hotelTier, '当地4钻酒店/-4');
  assert.equal(product.product.basicInfo.userIdea, idea, '上下文组装不能修改持久化需求');
});
