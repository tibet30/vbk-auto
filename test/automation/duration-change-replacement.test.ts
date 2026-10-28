import assert from "node:assert/strict";
import test from "node:test";
import {
  DurationChangeRejectedError,
  verifyItineraryReadback,
} from "../../src/main/automation/ctrip/itinerary-api/readback.js";
import { buildReadbackExpectations } from "../../src/main/automation/ctrip/itinerary-api/itinerary-transform.js";
import { PlatformOperationError } from "../../src/main/application/platform-operation-service.js";
import {
  isDurationChangeRejection,
  prepareDurationChangeReplacement,
  runWithDurationReplacement,
  type DurationReplacementDb,
} from "../../src/main/automation/automation.main/duration-change-replacement.js";
import { staleCompletedEntryPhases } from "../../src/main/automation/automation.main/changed-plan-phase-recovery.js";
import { stampCompletedEntryPhase } from "../../src/main/application/product-entry-phase-fingerprint.js";
import { buildProductSnapshot } from "../../src/main/infrastructure/database/parts/product-draft.js";
import { agentProductVersion, buildAgentApproval } from "../../src/main/agent/integration-gates.js";
import { assertAgentWriteAuthorized } from "../../src/main/agent/integration-guard.js";
import type { AgentSnapshot, AutomationRun, ProductDetail } from "../../src/shared/contracts.js";
import {
  baseProduct, clearRouteHandlers, installFetchStub, installHandlersForFieldMismatch,
  makeCandidate, makeFakePage, resetCallLog, uninstallFetchStub,
} from "./itinerary-api.test-helpers.ts";

test.after(() => { clearRouteHandlers(); uninstallFetchStub(); });

test("回读天数不一致抛出带类型的 DurationChangeRejectedError", async () => {
  resetCallLog();
  installFetchStub();
  installHandlersForFieldMismatch({ readbackDays: 3 });
  const air = makeCandidate("air", "LJG", "三义机场");
  const train = makeCandidate("train", "CN001LHM", "丽江");
  const expectations = buildReadbackExpectations({ itinerary: baseProduct.itinerary as never, operations: baseProduct.operations as never,
    stations: { pickupAir: air, pickupTrain: train, dropoffAir: air, dropoffTrain: train } });
  const error = await verifyItineraryReadback(makeFakePage() as never, "999999999999999999", expectations).catch((caught) => caught);
  assert.ok(error instanceof DurationChangeRejectedError);
  assert.equal(error.expectedDays, 2);
  assert.equal(error.actualDays, 3);
  // 平台写入包装后仍可识别；只认基本信息与行程阶段，不确定写入不转新建。
  const wrapped = new PlatformOperationError(error.message, "business_rejection", { cause: error });
  assert.equal(isDurationChangeRejection("itinerary", wrapped), true);
  assert.equal(isDurationChangeRejection("basic", new PlatformOperationError("保存失败：行程天数不能修改", "business_rejection")), true);
  assert.equal(isDurationChangeRejection("basic", new Error("本地校验：行程天数不能修改")), false);
  assert.equal(isDurationChangeRejection("terms", error), false);
  assert.equal(isDurationChangeRejection("itinerary", new Error("网络超时")), false);
  assert.equal(isDurationChangeRejection("basic", new PlatformOperationError("天数保存超时", "write_uncertain")), false);
});

function fakeDb(product: ProductDetail) {
  const lifecycle: unknown[] = [];
  const messages: string[] = [];
  const db = {
    getProduct: () => product,
    setProductLifecycle: (_id: string, updates: { productId?: string | null }) => {
      lifecycle.push(updates);
      if (updates.productId === null) delete product.productId;
    },
    addMessage: (_id: string, _role: string, content: string) => { messages.push(content); },
    getAgentSnapshot: () => undefined,
  } as unknown as DurationReplacementDb;
  return { db, lifecycle, messages };
}

function remoteProduct(): ProductDetail {
  const detail = buildProductSnapshot({ destination: "成都", days: 2, productForm: "privateTour" }) as ProductDetail;
  detail.productId = "79000001";
  detail.basicInfoSaved = true;
  detail.automation = { id: "old", status: "failed", currentPhase: "itinerary", logs: [], phases: [] };
  return detail;
}

const rejected = () => new PlatformOperationError("回读行程天数不一致：期望 4 天，实际 2 天", "business_rejection",
  { cause: new DurationChangeRejectedError(4, 2) });

test("天数被拒后本地解绑旧草稿、提示手动下线，并以新建产品重跑一次", async () => {
  const product = remoteProduct();
  const { db, lifecycle, messages } = fakeDb(product);
  const attempts: Array<string | undefined> = [];
  await runWithDurationReplacement({ db, localProductId: product.id, emit: () => {} }, async (replacement) => {
    attempts.push(replacement?.previousProductId);
    if (!replacement) throw rejected();
    assert.equal(product.productId, undefined, "重跑前远端绑定必须已清空");
  });
  assert.deepEqual(attempts, [undefined, "79000001"]);
  assert.deepEqual(lifecycle, [{ productId: null, status: "review", basicInfoSaved: false }]);
  assert.equal(messages.length, 1);
  assert.match(messages[0]!, /79000001/);
  assert.match(messages[0]!, /请在 VBK 后台手动下线或删除/);
});

test("同一轮第二次天数被拒不再转新建，直接失败；其它失败不转新建", async () => {
  const product = remoteProduct();
  const { db, lifecycle } = fakeDb(product);
  let calls = 0;
  const second = rejected();
  await assert.rejects(runWithDurationReplacement({ db, localProductId: product.id, emit: () => {} }, async () => {
    calls += 1;
    product.productId = `7900000${calls}`;
    if (calls === 2) product.automation = { ...product.automation!, durationReplacement: { previousProductId: "79000001", at: "x" } };
    throw calls === 1 ? rejected() : second;
  }), (error) => error === second);
  assert.equal(calls, 2);
  assert.equal(lifecycle.length, 1);
  delete product.automation!.durationReplacement;
  product.automation!.currentPhase = "terms";
  const other = rejected();
  await assert.rejects(runWithDurationReplacement({ db, localProductId: product.id, emit: () => {} },
    async () => { throw other; }), (error) => error === other);
  assert.equal(lifecycle.length, 1);
});

test("Agent 录入以 needs_user 落库的天数拒绝同样转新建一次", async () => {
  const product = remoteProduct();
  const { db, lifecycle, messages } = fakeDb(product);
  const attempts: Array<string | undefined> = [];
  await runWithDurationReplacement({ db, localProductId: product.id, emit: () => {} }, async (replacement) => {
    attempts.push(replacement?.previousProductId);
    if (replacement) return;
    product.automation = { id: "old", status: "failed", currentPhase: "basic", logs: [], phases: [],
      recovery: { phases: { basic: { phase: "basic", state: "needs_user", attempts: [],
        finalError: "VBK 基本信息保存失败（Ack=Failure）：行程天数不能修改" } } } };
  });
  assert.deepEqual(attempts, [undefined, "79000001"]);
  assert.equal(lifecycle.length, 1);
  assert.equal(messages.length, 1);
  // 其它阶段的普通失败不转新建。
  const other = remoteProduct();
  const plain = fakeDb(other);
  await runWithDurationReplacement({ db: plain.db, localProductId: other.id, emit: () => {} }, async () => {
    other.automation = { id: "old", status: "failed", currentPhase: "terms", logs: [], phases: [],
      recovery: { phases: { terms: { phase: "terms", state: "needs_user", attempts: [], finalError: "天数不一致" } } } };
  });
  assert.equal(plain.lifecycle.length, 0);
});

test("没有远端草稿时不能转新建", () => {
  const product = remoteProduct();
  delete product.productId;
  assert.throws(() => prepareDurationChangeReplacement(product), /没有可替代的远端草稿/);
  assert.deepEqual(prepareDurationChangeReplacement(remoteProduct()), { previousProductId: "79000001" });
});

test("天数变化后已完成录入的第一个过期阶段是 basic（Review Focus 4）", () => {
  const product = remoteProduct();
  const phases = ["basic", "presentation", "itinerary", "package", "terms", "preflight"];
  const run: AutomationRun = { id: "r", status: "succeeded", logs: [], phases: phases.map((phase) => ({ phase, status: "completed" as const })) };
  for (const phase of phases) stampCompletedEntryPhase(run, product.product as Record<string, unknown>, phase);
  product.automation = run;
  assert.deepEqual(staleCompletedEntryPhases(product, phases), []);
  Object.assign(product.product.basicInfo!, { days: 4, nights: 3 });
  assert.equal(staleCompletedEntryPhases(product, phases)[0], "basic");
});

test("转新建产品只为本次批准补出 saleControl 写权限", () => {
  const product = remoteProduct();
  const approval = { id: "approval", ...buildAgentApproval(product), accountKey: "account",
    productVersion: agentProductVersion(product), intentVersion: "intent", status: "approved" as const, createdAt: "x" };
  const snapshot: AgentSnapshot = { localProductId: product.id, events: [{ id: "e", runId: "r", type: "approval", content: "确认", createdAt: "x", data: { approval } }],
    run: { id: "r", status: "running", intentVersion: "intent", createdAt: "x", updatedAt: "x" } };
  assert.ok(!approval.scope.includes("vbk.write_phase:saleControl"));
  delete product.productId;
  product.automation = { id: "new", status: "running", logs: [], phases: [] };
  assert.throws(() => assertAgentWriteAuthorized(product, snapshot, "saleControl", "account"));
  product.automation.durationReplacement = { previousProductId: "79000001", approvalId: "other", at: "x" };
  assert.throws(() => assertAgentWriteAuthorized(product, snapshot, "saleControl", "account"));
  product.automation.durationReplacement.approvalId = "approval";
  assert.doesNotThrow(() => assertAgentWriteAuthorized(product, snapshot, "saleControl", "account"));
  assert.doesNotThrow(() => assertAgentWriteAuthorized(product, snapshot, "basic", "account"));
  product.productId = "79000002";
  assert.throws(() => assertAgentWriteAuthorized(product, snapshot, "saleControl", "account"));
});
