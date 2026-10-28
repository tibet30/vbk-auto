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
import { agentApprovalScopeError, assertAgentWriteAuthorized, normalizeAgentApprovalScope } from "../../src/main/agent/integration-guard.js";
import type { AgentSnapshot, AutomationRun, ProductDetail } from "../../src/shared/contracts.js";
import { DURATION_REPLACEMENT_SCOPE } from "../../src/shared/duration-replacement.js";
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

const remoteDraft = (active = "D", releaseActive = "F") => ({ data: { saleControlInfo: { productCategoryID: 1 },
  baseInfo: { active }, meta: { auditStatus: "N", releaseActive } } });

function approvalSnapshot(scope: string[]): AgentSnapshot {
  const approval = { id: "approval-1", scope, status: "approved" };
  return { localProductId: "p", events: [{ id: "e", runId: "r", type: "approval", content: "确认", createdAt: "x", data: { approval } }],
    run: { id: "r", status: "running", intentVersion: "i", createdAt: "x", updatedAt: "x" } } as unknown as AgentSnapshot;
}

function fakeDb(product: ProductDetail, scope: string[] = [DURATION_REPLACEMENT_SCOPE], remote: unknown = remoteDraft()) {
  const lifecycle: unknown[] = [];
  const messages: string[] = [];
  const remoteReads: string[] = [];
  const db = {
    getProduct: () => product,
    setProductLifecycle: (_id: string, updates: { productId?: string | null }) => {
      lifecycle.push(updates);
      if (updates.productId === null) delete product.productId;
    },
    addMessage: (_id: string, _role: string, content: string) => { messages.push(content); },
    getAgentSnapshot: () => approvalSnapshot(scope),
  } as unknown as DurationReplacementDb;
  const deps = { db, localProductId: product.id, emit: () => {},
    readRemoteBaseInfo: async (productId: string) => { remoteReads.push(productId); return remote; } };
  return { db, deps, lifecycle, messages, remoteReads };
}

/** 远端草稿上次录入 2 天，本地已改成 4 天。 */
function remoteProduct(): ProductDetail {
  const detail = buildProductSnapshot({ destination: "成都", days: 2, productForm: "privateTour" }) as ProductDetail;
  detail.productId = "79000001";
  detail.basicInfoSaved = true;
  Object.assign(detail.product.basicInfo!, { days: 4, nights: 3 });
  detail.automation = { id: "old", status: "failed", currentPhase: "itinerary", logs: [], phases: [], enteredItineraryDays: 2 };
  return detail;
}

const rejected = () => new PlatformOperationError("回读行程天数不一致：期望 4 天，实际 2 天", "business_rejection",
  { cause: new DurationChangeRejectedError(4, 2) });

test("天数被拒后只读确认旧草稿未发布，本地解绑、提示手动下线，并以新建产品重跑一次", async () => {
  const product = remoteProduct();
  const { deps, lifecycle, messages, remoteReads } = fakeDb(product);
  const attempts: Array<string | undefined> = [];
  await runWithDurationReplacement(deps, async (replacement) => {
    attempts.push(replacement?.previousProductId);
    if (!replacement) throw rejected();
    assert.equal(replacement.approvalId, "approval-1");
    assert.equal(product.productId, undefined, "重跑前远端绑定必须已清空");
  });
  assert.deepEqual(remoteReads, ["79000001"]);
  assert.deepEqual(attempts, [undefined, "79000001"]);
  assert.deepEqual(lifecycle, [{ productId: null, status: "review", basicInfoSaved: false }]);
  assert.equal(messages.length, 1);
  assert.match(messages[0]!, /79000001/);
  assert.match(messages[0]!, /请在 VBK 后台手动下线或删除/);
});

test("同一轮第二次天数被拒不再转新建，直接失败；其它失败不转新建", async () => {
  const product = remoteProduct();
  const { deps, lifecycle } = fakeDb(product);
  let calls = 0;
  const second = rejected();
  await assert.rejects(runWithDurationReplacement(deps, async () => {
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
  await assert.rejects(runWithDurationReplacement(deps, async () => { throw other; }), (error) => error === other);
  assert.equal(lifecycle.length, 1);
});

test("Agent 录入以 needs_user 落库的天数拒绝同样转新建一次", async () => {
  const product = remoteProduct();
  const { deps, lifecycle, messages } = fakeDb(product);
  const attempts: Array<string | undefined> = [];
  await runWithDurationReplacement(deps, async (replacement) => {
    attempts.push(replacement?.previousProductId);
    if (replacement) return;
    product.automation = { id: "old", status: "failed", currentPhase: "basic", logs: [], phases: [], enteredItineraryDays: 2,
      recovery: { phases: { basic: { phase: "basic", state: "needs_user", attempts: [],
        finalError: "VBK 基本信息保存失败（Ack=Failure）：行程天数不能修改" } } } };
  });
  assert.deepEqual(attempts, [undefined, "79000001"]);
  assert.equal(lifecycle.length, 1);
  assert.equal(messages.length, 1);
  // 其它阶段的普通失败不转新建。
  const other = remoteProduct();
  const plain = fakeDb(other);
  await runWithDurationReplacement(plain.deps, async () => {
    other.automation = { id: "old", status: "failed", currentPhase: "terms", logs: [], phases: [], enteredItineraryDays: 2,
      recovery: { phases: { terms: { phase: "terms", state: "needs_user", attempts: [], finalError: "天数不一致" } } } };
  });
  assert.equal(plain.lifecycle.length, 0);
});

test("天数未变化时，天数类拒绝按普通失败处理，不解绑也不读远端", async () => {
  for (const entered of [4, undefined]) {
    const product = remoteProduct();
    product.automation!.enteredItineraryDays = entered;
    const { deps, lifecycle, messages, remoteReads } = fakeDb(product);
    const error = rejected();
    await assert.rejects(runWithDurationReplacement(deps, async () => { throw error; }), (caught) => caught === error);
    assert.equal(product.productId, "79000001");
    assert.deepEqual([lifecycle.length, messages.length, remoteReads.length], [0, 0, 0]);
  }
});

test("批准未包含 vbk.duration_replacement 时不转新建，阶段失败并要求重新确认", async () => {
  const product = remoteProduct();
  const { deps, lifecycle, messages, remoteReads } = fakeDb(product, ["vbk.write_phase:basic"]);
  const original = rejected();
  await assert.rejects(runWithDurationReplacement(deps, async () => { throw original; }),
    (error: Error) => /未授权「保留旧草稿并新建产品」/.test(error.message) && error.cause === original);
  assert.equal(product.productId, "79000001");
  assert.deepEqual([lifecycle.length, remoteReads.length], [0, 0]);
  assert.match(messages[0]!, /重新确认/);
});

test("转新建前远端只读核对未通过（已提审/已发布/读取失败）时不解绑", async () => {
  for (const remote of [remoteDraft("T"), remoteDraft("D", "T"), { data: { baseInfo: { active: "D" }, meta: { auditStatus: "P", releaseActive: "F" } } }]) {
    const product = remoteProduct();
    const { deps, lifecycle, messages } = fakeDb(product, [DURATION_REPLACEMENT_SCOPE], remote);
    await assert.rejects(runWithDurationReplacement(deps, async () => { throw rejected(); }), /远端只读核对未通过/);
    assert.equal(product.productId, "79000001");
    assert.equal(lifecycle.length, 0);
    assert.match(messages[0]!, /不会新建产品/);
  }
  const product = remoteProduct();
  const failing = fakeDb(product);
  failing.deps.readRemoteBaseInfo = async () => { throw new Error("网络超时"); };
  await assert.rejects(runWithDurationReplacement(failing.deps, async () => { throw rejected(); }), /网络超时/);
  assert.equal(failing.lifecycle.length, 0);
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
  assert.equal(run.enteredItineraryDays, 4, "itinerary 阶段完成时记录已录入天数");
  Object.assign(product.product.basicInfo!, { days: 5, nights: 4 });
  assert.equal(staleCompletedEntryPhases(product, phases)[0], "basic");
});

test("确认卡：天数相对远端已录入天数变化时才包含转新建范围与说明", () => {
  const changed = buildAgentApproval(remoteProduct());
  assert.ok(changed.scope.includes(DURATION_REPLACEMENT_SCOPE));
  assert.match(changed.summary, /若 VBK 拒绝改天数，将保留旧草稿 79000001 并新建产品重新录入。/);
  for (const mutate of [(p: ProductDetail) => { p.automation!.enteredItineraryDays = 4; },
    (p: ProductDetail) => { delete p.automation!.enteredItineraryDays; }, (p: ProductDetail) => { delete p.productId; }]) {
    const product = remoteProduct();
    mutate(product);
    const approval = buildAgentApproval(product);
    assert.ok(!approval.scope.includes(DURATION_REPLACEMENT_SCOPE));
    assert.doesNotMatch(approval.summary, /新建产品重新录入/);
  }
  // 模型按 requiredApprovalScope 提交时，系统推导的转新建范围会被补齐，且通过范围校验。
  const product = remoteProduct();
  const phases = changed.scope.filter((item) => item.startsWith("vbk.write_phase:"));
  assert.ok(normalizeAgentApprovalScope(product, phases).includes(DURATION_REPLACEMENT_SCOPE));
  assert.equal(agentApprovalScopeError(product, changed.scope), undefined);
  const unchanged = remoteProduct();
  unchanged.automation!.enteredItineraryDays = 4;
  assert.match(agentApprovalScopeError(unchanged, changed.scope) ?? "", /不支持的录入范围/);
});

function writeSnapshot(product: ProductDetail, scope: string[]) {
  const approval = { id: "approval", ...buildAgentApproval(product), scope, accountKey: "account",
    productVersion: agentProductVersion(product), intentVersion: "intent", status: "approved" as const, createdAt: "x" };
  const snapshot: AgentSnapshot = { localProductId: product.id, events: [{ id: "e", runId: "r", type: "approval", content: "确认", createdAt: "x", data: { approval } }],
    run: { id: "r", status: "running", intentVersion: "intent", createdAt: "x", updatedAt: "x" } };
  return { approval, snapshot };
}

test("转新建产品只在批准显式包含 vbk.duration_replacement 时补出 saleControl 写权限", () => {
  const product = remoteProduct();
  const { approval, snapshot } = writeSnapshot(product, buildAgentApproval(product).scope);
  assert.ok(approval.scope.includes(DURATION_REPLACEMENT_SCOPE));
  assert.ok(!approval.scope.includes("vbk.write_phase:saleControl"));
  const versionBefore = agentProductVersion(product);
  delete product.productId;
  // 产品版本只由 product.product 计算：解绑不会让原批准因版本不符失效。
  assert.equal(agentProductVersion(product), versionBefore);
  product.automation = { id: "new", status: "running", logs: [], phases: [] };
  assert.throws(() => assertAgentWriteAuthorized(product, snapshot, "saleControl", "account"));
  product.automation.durationReplacement = { previousProductId: "79000001", approvalId: "other", at: "x" };
  assert.throws(() => assertAgentWriteAuthorized(product, snapshot, "saleControl", "account"));
  product.automation.durationReplacement.approvalId = "approval";
  assert.doesNotThrow(() => assertAgentWriteAuthorized(product, snapshot, "saleControl", "account"));
  assert.doesNotThrow(() => assertAgentWriteAuthorized(product, snapshot, "basic", "account"));
  product.productId = "79000002";
  assert.throws(() => assertAgentWriteAuthorized(product, snapshot, "saleControl", "account"));

  // 批准未显式包含该范围：即使记录了同一批准 ID，也不补出 saleControl。
  const plain = remoteProduct();
  const without = writeSnapshot(plain, buildAgentApproval(plain).scope.filter((item) => item !== DURATION_REPLACEMENT_SCOPE));
  delete plain.productId;
  plain.automation = { id: "new", status: "running", logs: [], phases: [],
    durationReplacement: { previousProductId: "79000001", approvalId: "approval", at: "x" } };
  assert.throws(() => assertAgentWriteAuthorized(plain, without.snapshot, "saleControl", "account"));
});
