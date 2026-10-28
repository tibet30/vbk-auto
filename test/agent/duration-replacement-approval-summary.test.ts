import assert from "node:assert/strict";
import test from "node:test";
import { AgentCore } from "../../src/main/agent/core.js";
import { normalizeAgentApprovalScope } from "../../src/main/agent/integration-guard.js";
import { requiredAgentPhases } from "../../src/main/agent/integration-gates.js";
import { buildProductSnapshot } from "../../src/main/infrastructure/database/parts/product-draft.js";
import { DURATION_REPLACEMENT_SCOPE, durationReplacementNotice, withDurationReplacementNotice } from "../../src/shared/duration-replacement.js";
import type { AgentCoreDependencies } from "../../src/main/agent/types.js";
import type { AgentSnapshot, ProductDetail } from "../../src/shared/contracts.js";

const NOTICE = "若 VBK 拒绝改天数，将保留旧草稿 79000001 并新建产品重新录入。";

/** 远端草稿 79000001 上次录入 2 天；changed=true 时本地已改成 4 天。 */
function product(changed: boolean): ProductDetail {
  const detail = buildProductSnapshot({ destination: "成都", days: 2, productForm: "privateTour" }) as ProductDetail;
  detail.productId = "79000001";
  detail.basicInfoSaved = true;
  if (changed) Object.assign(detail.product.basicInfo!, { days: 4, nights: 3 });
  detail.automation = { id: "old", status: "succeeded", logs: [], phases: [], enteredItineraryDays: 2 };
  return detail;
}

/** 与 integration-setup.ts 相同的接线：模型 request_approval → 范围归一化 → 统一说明补全。 */
async function modelApproval(current: ProductDetail, summary: string) {
  const saved = new Map<string, AgentSnapshot>();
  const deps: AgentCoreDependencies = {
    model: { complete: async () => ({ toolCalls: [{ id: "approval", name: "request_approval",
      // 模型按 read_product.requiredApprovalScope 原样提交阶段范围。
      arguments: { scope: requiredAgentPhases(current).map((phase) => `vbk.write_phase:${phase}`), summary } }] }) },
    tools: [],
    accountFor: async () => ({ accountKey: "account", productVersion: "version" }),
    productFingerprint: async () => "same-product",
    id: (() => { let index = 0; return () => `id-${++index}`; })(),
    now: () => new Date("2026-10-29T00:00:00.000Z"),
    normalizeApprovalScope: (_id, scope) => normalizeAgentApprovalScope(current, scope),
    approvalPrecondition: async () => undefined,
    completeApprovalSummary: (_id, scope, text) => withDurationReplacementNotice(text, scope, current),
  };
  const core = new AgentCore(deps, {
    getAgentSnapshot: (id: string) => saved.get(id),
    saveAgentSnapshot: (snapshot: AgentSnapshot) => { saved.set(snapshot.localProductId, structuredClone(snapshot)); },
  });
  await core.send(current.id, "开始录入");
  await core.idle(current.id);
  const snapshot = await core.get(current.id);
  return { approval: snapshot.pendingApproval!, event: snapshot.events.find((item) => item.type === "approval_request")! };
}

test("模型 request_approval 写的说明在改天数时补出旧草稿 ID 与新建产品提示", async () => {
  const { approval, event } = await modelApproval(product(true), "成都 4天3晚，请确认录入。");
  assert.ok(approval.scope.includes(DURATION_REPLACEMENT_SCOPE));
  assert.ok(approval.summary.startsWith("成都 4天3晚，请确认录入。"));
  assert.ok(approval.summary.includes(NOTICE), approval.summary);
  assert.ok(event.content.includes(NOTICE), "对话中展示的确认卡内容同样包含提示");
});

test("天数未变化时确认卡不含转新建范围与提示", async () => {
  const { approval } = await modelApproval(product(false), "成都 2天1晚，请确认录入。");
  assert.ok(!approval.scope.includes(DURATION_REPLACEMENT_SCOPE));
  assert.doesNotMatch(approval.summary, /新建产品重新录入/);
  assert.equal(approval.summary, "成都 2天1晚，请确认录入。");
});

test("说明已包含提示时不重复追加（幂等）", async () => {
  const current = product(true);
  assert.equal(durationReplacementNotice(current), NOTICE);
  const scope = [DURATION_REPLACEMENT_SCOPE];
  const once = withDurationReplacementNotice("请确认。", scope, current);
  assert.equal(withDurationReplacementNotice(once, scope, current), once);
  assert.equal(once.split(NOTICE).length - 1, 1);
  const { approval } = await modelApproval(current, `成都 4天3晚。${NOTICE}请确认录入。`);
  assert.equal(approval.summary.split(NOTICE).length - 1, 1, approval.summary);
  // 范围不含转新建时不补提示。
  assert.equal(withDurationReplacementNotice("请确认。", ["vbk.write_phase:basic"], current), "请确认。");
});
