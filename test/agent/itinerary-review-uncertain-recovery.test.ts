import assert from "node:assert/strict";
import test from "node:test";
import { reconcileUncertainAgentWrite } from "../../src/main/agent/integration-setup/reconcile-uncertain-write.js";

const localProductId = "b175b8b9-f16b-48ff-aa90-13e5d4db51a8";
const productId = "79735280";
const approvalId = "b22deb57-a8ca-4e25-add3-38178a00bd9f";
const runId = "263be36d-fa9e-49a3-9719-0ea5dd411a9d";
const accountKey = "vbk_671205";
const validationOnlyMessage = "已确认先前仅执行校验且远端草稿未变化，可自动重新校验";
const verifiedValidationOnlyMessage = "已只读确认审核校验未改变远端草稿，可继续当前批准流程";

function review(overrides: Record<string, unknown> = {}) {
  return {
    localProductId,
    status: "requires_review",
    attemptId: "",
    approvalId,
    agentRunId: runId,
    productId,
    accountKey,
    tourInfoId: "420282192824975390",
    beforeDigest: "7e817dd374a0f7578668fd0c6819451bc69f2d26e2af67e167210f7ff20361b9",
    requestSteps: [],
    message: validationOnlyMessage,
    updatedAt: "2026-10-14T04:29:34.940Z",
    ...overrides,
  } as any;
}

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    run: { id: runId },
    events: [{ runId, type: "approval", data: { approval: {
      id: approvalId, accountKey, status: "approved", itineraryReviewUnlockAuthorized: true,
    } } }],
    ...overrides,
  } as any;
}

function harness(state = review(), product: any = { id: localProductId, productId }, agent = snapshot()) {
  const calls = { status: 0, remote: 0 };
  const observations: any[] = [];
  const savedReviewStates: any[] = [];
  const context = {
    db: {
      runProductTransaction: (work: () => unknown) => work(),
      getItineraryReviewUnlockState: () => state,
      getProduct: () => product,
      getAgentSnapshot: () => agent,
      saveItineraryReviewUnlockState: (value: any) => { savedReviewStates.push(value); },
      recordResourceObservation: (_id: string, observation: any) => {
        observations.push(observation);
        const rows = product?.resourceEvidence?.observations;
        const index = rows?.findIndex((row: any) => row.id === observation.id) ?? -1;
        if (index >= 0) rows[index] = observation;
      },
    },
    productWorkflows: { runVbkPageExclusive: async (work: () => Promise<unknown>) => work() },
    browser: { status: async () => { calls.status += 1; throw new Error("must not reach VBK"); } },
    remoteProducts: { get: async () => { calls.remote += 1; throw new Error("must not reach product service"); } },
  } as any;
  return { calls, observations, savedReviewStates, run: reconcileUncertainAgentWrite(context) };
}

function itineraryDispatchProduct() {
  return {
    id: localProductId, productId, vbkAccount: accountKey,
    resourceEvidence: { observations: [{
      id: "itinerary-dispatch",
      capability: "write_phase:itinerary",
      status: "write_dispatched",
    }] },
  };
}

test("same-run verified review reconciles the uncertain itinerary phase without another platform request", async () => {
  const product = itineraryDispatchProduct();
  const target = harness(review({
    status: "verified", attemptId: "attempt",
    afterDigest: "7e817dd374a0f7578668fd0c6819451bc69f2d26e2af67e167210f7ff20361b9",
    receipt: { verified: true }, message: undefined,
  }), { ...product, vbkAccount: accountKey });
  const result = await target.run(localProductId, { toolCallId: "phase:itinerary", message: "不确定" });
  assert.equal(result.reconciled, true);
  assert.equal(result.phase, "itinerary");
  assert.match(result.message ?? "", /回读确认/);
  assert.equal(product.resourceEvidence.observations[0].status, "write_checked");
  assert.deepEqual(target.calls, { status: 0, remote: 0 });
});

test("完整方案只读回读写入的精确标记允许同一批准流程定向重试", async () => {
  const product = itineraryDispatchProduct();
  const target = harness(review({ message: verifiedValidationOnlyMessage }), product);
  const result = await target.run(localProductId, { toolCallId: "phase:itinerary", message: "不确定" });
  assert.equal(result.reconciled, false);
  assert.equal(result.retryable, true);
  assert.match(result.message ?? "", /同一批准范围/);
  assert.equal(product.resourceEvidence.observations[0].status, "write_checked");
  assert.equal(target.observations.length, 1);
  assert.deepEqual(target.calls, { status: 0, remote: 0 });
});

test("空回执不能证明审核校验未到达平台，旧确认不能清理 uncertain dispatch", async () => {
  const target = harness();
  const result = await target.run(localProductId, { toolCallId: "phase:itinerary", message: "不确定" });
  assert.equal(result.reconciled, false);
  assert.equal(result.retryable, undefined);
  assert.match(result.message ?? "", /不会以旧确认自动重试/);
  assert.deepEqual(target.calls, { status: 0, remote: 0 });
});

test("历史 validation-only 标记也不能重新启用 write_dispatched 收据", async () => {
  const trustedProduct = itineraryDispatchProduct();
  const trusted = harness(review(), trustedProduct);
  const recovered = await trusted.run(localProductId, { toolCallId: "phase:itinerary", message: "不确定" });
  assert.equal(recovered.retryable, undefined);
  assert.deepEqual(trusted.observations, []);
  assert.equal(trustedProduct.resourceEvidence.observations[0].status, "write_dispatched");
  assert.deepEqual(trusted.calls, { status: 0, remote: 0 });

  const blockedProduct = itineraryDispatchProduct();
  const blocked = harness(review({ message: "仍待核查" }), blockedProduct);
  const stopped = await blocked.run(localProductId, { toolCallId: "phase:itinerary", message: "不确定" });
  assert.equal(stopped.retryable, undefined);
  assert.deepEqual(blocked.observations, []);
  assert.equal(blockedProduct.resourceEvidence.observations[0].status, "write_dispatched");
  assert.deepEqual(blocked.calls, { status: 0, remote: 0 });
});

test("平台只读校验驳回行程文案的历史 uncertain 状态可自动重试并重置审核边界", async () => {
  const product = itineraryDispatchProduct();
  const target = harness(review({
    status: "uncertain",
    attemptId: "27e48053-4995-44e3-8f02-509b5e43c151",
    message: "行程审核校验失败（Ack=Failure）：保存第1天行程描述，提示非法关键词：药浴，请修改后重新提交",
  }), product);
  const result = await target.run(localProductId, { toolCallId: "phase:itinerary", message: "不确定" });
  assert.equal(result.reconciled, false);
  assert.equal(result.retryable, true);
  assert.match(result.message ?? "", /自动修正文案后重新提交/);
  assert.equal(product.resourceEvidence.observations[0].status, "write_checked");
  assert.deepEqual(target.calls, { status: 0, remote: 0 });
  assert.equal(target.savedReviewStates.length, 1);
  const reset = target.savedReviewStates[0];
  assert.equal(reset.status, "requires_review");
  assert.equal(reset.attemptId, "");
  assert.deepEqual(reset.requestSteps, []);
  assert.equal(reset.digestMismatch, undefined);
  assert.equal(reset.receipt, undefined);
  assert.match(reset.message, /^平台在只读校验阶段驳回了行程文案/);
});

test("完整只读核查确认零写入后允许跨旧审批清障，后续仍由方案指纹要求新审批", async () => {
  const product = itineraryDispatchProduct();
  const currentApprovalId = "4160cb75-bfd5-47d7-bb08-6cab9c259bdc";
  const agent = snapshot({
    events: [{ runId, type: "approval", data: { approval: {
      id: currentApprovalId, accountKey, status: "approved", itineraryReviewUnlockAuthorized: true,
    } } }],
  });
  const target = harness(review({
    approvalId: "bef0de4e-40da-4423-b4e3-3181ebc252f1",
    message: "平台在只读校验阶段驳回了行程文案，未形成远端写入，可修正文案后重新提交",
  }), product, agent);
  const result = await target.run(localProductId, { toolCallId: "phase:itinerary", message: "不确定" });
  assert.equal(result.reconciled, false);
  assert.equal(result.retryable, true);
  assert.equal(product.resourceEvidence.observations[0].status, "write_checked");
  assert.deepEqual(target.calls, { status: 0, remote: 0 });
});

test("未经过完整只读核查的历史驳回不能跨审批清障", async () => {
  const currentApprovalId = "4160cb75-bfd5-47d7-bb08-6cab9c259bdc";
  const agent = snapshot({
    events: [{ runId, type: "approval", data: { approval: {
      id: currentApprovalId, accountKey, status: "approved", itineraryReviewUnlockAuthorized: true,
    } } }],
  });
  const target = harness(review({
    status: "uncertain",
    attemptId: "27e48053-4995-44e3-8f02-509b5e43c151",
    message: "行程审核校验失败（Ack=Failure）：保存第1天行程描述，提示非法关键词：药浴，请修改后重新提交",
  }), itineraryDispatchProduct(), agent);
  const result = await target.run(localProductId, { toolCallId: "phase:itinerary", message: "不确定" });
  assert.equal(result.retryable, undefined);
  assert.match(result.message ?? "", /不会以旧确认自动重试/);
  assert.deepEqual(target.observations, []);
});

test("行程 uncertain 缺少任一可信标记时保持停止且不请求平台", async (t) => {
  const cases: Array<[string, () => ReturnType<typeof harness>]> = [
    ["状态不是 requires_review", () => harness(review({ status: "uncertain" }))],
    ["没有空步骤数组", () => harness(review({ requestSteps: undefined }))],
    ["已有步骤回执", () => harness(review({ requestSteps: [{ step: "check8" }] }))],
    ["没有验证专用消息", () => harness(review({ message: "仍待核查" }))],
    ["本地产品身份不一致", () => harness(review({ localProductId: "other" }))],
    ["产品绑定缺失", () => harness(review(), null)],
    ["远端产品编号不一致", () => harness(review(), { id: localProductId, productId: "other" })],
    ["当前批准绑定缺失", () => harness(review(), { id: localProductId, productId }, snapshot({ events: [] }))],
    ["混入已提交回读字段", () => harness(review({ afterDigest: "a".repeat(64) }))],
  ];
  for (const [name, create] of cases) await t.test(name, async () => {
    const target = create();
    const result = await target.run(localProductId, { toolCallId: "phase:itinerary", message: "不确定" });
    assert.equal(result.reconciled, false);
    assert.equal(result.retryable, undefined);
    assert.match(result.message ?? "", /不会以旧确认自动重试/);
    assert.deepEqual(target.calls, { status: 0, remote: 0 });
  });
});
