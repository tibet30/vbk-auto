import assert from "node:assert/strict";
import test from "node:test";
import { AgentCore } from "../../src/main/agent/core.js";
import { removeConfirmedDomesticShortPoiRisk } from "../../src/main/agent/domestic-short-poi-removal.js";
import { installProductAgent } from "../../src/main/agent/integration-setup.js";
import type { AgentCoreDependencies } from "../../src/main/agent/types.js";
import {
  DOMESTIC_SHORT_POI_KEEP_OPTION,
  DOMESTIC_SHORT_POI_REMOVE_OPTION,
  domesticShortPoiRiskQuestion,
} from "../../src/shared/domestic-short-poi-risk.js";
import type { AgentApproval, AgentSnapshot, ProductDetail } from "../../src/shared/contracts.js";
import { preserveItineraryRemovals } from "../../src/shared/preserve-itinerary-removals.js";
import { trustedOperatorItineraryRemovals } from "../../src/shared/trusted-operator-itinerary-removals.js";
import type { MainIpcContext } from "../../src/main/ipc/context.js";

const RISK = "行程审核校验失败（Ack=Failure）：数据风险，原因：POI：冈仁波齐 且 产品类型：境内短途旅游，请修改后重新操作";

function product(): ProductDetail {
  return {
    id: "product", name: "拉萨7天6晚私家团", status: "blocked", updatedAt: "x", messages: [], researchTasks: [],
    product: {
      itinerary: [
        { day: 4, spots: [
          { name: "公珠措", poiName: "公珠错", poiId: 91992 },
          { name: "冈仁波齐", poiName: "冈仁波齐", poiId: 10758151 },
        ] },
        { day: 5, spots: [{ name: "远眺冈仁波齐", poiName: "冈仁波齐", poiId: 10758151 }] },
        { day: 6, spots: [
          { name: "冈仁波齐山体冰川遗迹", poiName: "冈仁波齐", poiId: 10758151 },
          { name: "玛旁雍措", poiName: "玛旁雍措", poiId: 78548 },
        ] },
      ],
    },
  };
}

test("确认数据风险后只剔除所有匹配 POI，并留下逐日人工删除凭证", () => {
  const detail = product();
  const question = domesticShortPoiRiskQuestion(RISK)!;
  const result = removeConfirmedDomesticShortPoiRisk(detail, [{
    id: question.id, label: question.label, selectedLabel: question.options![0]!.label,
  }])!;
  assert.equal(result.removed, 3);
  assert.deepEqual((result.product.itinerary as Array<{ spots: Array<{ name: string }> }>).map(day => day.spots.map(spot => spot.name)), [
    ["公珠措"], [], ["玛旁雍措"],
  ]);
  assert.deepEqual((result.product.manualReview as { itinerarySpotRemovals: Array<{ day: number; name: string }> }).itinerarySpotRemovals
    .map(item => [item.day, item.name]), [[6, "冈仁波齐山体冰川遗迹"], [5, "远眺冈仁波齐"], [4, "冈仁波齐"]]);
  const receipts = (result.product.manualReview as {
    itinerarySpotRemovals: Array<{ poiName?: string; poiId?: number }>;
  }).itinerarySpotRemovals;
  assert.ok(receipts.every((item) => item.poiName === "冈仁波齐" && item.poiId === 10758151));
  const staleAlias = structuredClone(result.product);
  (staleAlias.itinerary as Array<{ day: number; spots: unknown[] }>)[0]!.spots.push({
    name: "冈仁波齐山体冰川遗迹", poiName: "冈仁波齐", poiId: 10758151,
  });
  const guarded = preserveItineraryRemovals(result.product, staleAlias);
  assert.deepEqual((guarded.itinerary as Array<{ spots: Array<{ name: string }> }>)[0]!.spots.map(item => item.name), ["公珠措"]);
  assert.equal(detail.product.manualReview, undefined, "纯函数不能修改原产品");
});

test("集成指令先处理显式恢复再执行确认剔除，不能清空本次 trusted removal", () => {
  let detail = { ...product(), productJsonVersion: 1 };
  const question = domesticShortPoiRiskQuestion(RISK)!;
  const context = {
    db: { getProduct: () => detail },
    productMutations: { commands: { mergeChanges: (_id: string, _baseline: ProductDetail, next: Record<string, unknown>) => {
      detail = { ...detail, product: next, productJsonVersion: (detail.productJsonVersion ?? 0) + 1 } as ProductDetail;
      return detail;
    } } },
    productWorkflows: {}, remoteProducts: {}, emitProduct: () => {},
  } as unknown as MainIpcContext;
  installProductAgent(context);
  const prepare = (context.agentCore as unknown as { deps: AgentCoreDependencies }).deps.prepareUserInstruction!;
  const changed = prepare("product", "恢复D4冈仁波齐", { selectedQuestions: [{
    id: question.id, label: question.label, selectedLabel: question.options![0]!.label,
  }] });
  assert.equal(changed, true);
  assert.equal(trustedOperatorItineraryRemovals(detail.product).some((receipt) => receipt.day === 4
    && receipt.poiId === 10758151), true);
  assert.equal((detail.product.itinerary as Array<{ spots: Array<{ poiId?: number }> }>)[0]!.spots
    .some((spot) => spot.poiId === 10758151), false);
});

function harness() {
  let detail = product();
  let preparationCalls = 0;
  const approval: AgentApproval = {
    id: "approval", productVersion: "version", accountKey: "account", scope: ["vbk.write_phase:itinerary"],
    summary: "录入", status: "approved", createdAt: "x", intentVersion: "intent",
  };
  const snapshots = new Map<string, AgentSnapshot>([["product", {
    localProductId: "product",
    run: { id: "run", status: "paused", createdAt: "x", updatedAt: "x", intentVersion: "intent" },
    events: [
      { id: "approval-event", runId: "run", type: "approval", createdAt: "x", content: "用户已授权", data: { approval } },
      { id: "risk-event", runId: "run", type: "status", createdAt: "x", content: `自动录入已暂停：${RISK}`, data: { status: "paused" } },
    ],
  }]]);
  const deps: AgentCoreDependencies = {
    id: (() => { let value = 0; return () => `id-${++value}`; })(),
    tools: [], accountFor: async () => ({ accountKey: "account", productVersion: "version" }),
    productFingerprint: async () => JSON.stringify(detail.product),
    prepareUserInstruction: (_id, _content, selection) => {
      preparationCalls += 1;
      const result = removeConfirmedDomesticShortPoiRisk(detail, selection?.selectedQuestions ?? []);
      if (!result?.removed) return false;
      detail = { ...detail, product: result.product };
      return true;
    },
    model: { complete: async () => ({ content: "等待重新确认录入。" }) },
    requiresCompletionVerification: () => true,
    finishVerified: async () => ({ verified: false, finalApproval: {
      scope: ["vbk.write_phase:itinerary"], summary: "调整后方案需重新确认录入。",
    } }),
  };
  const core = new AgentCore(deps, {
    getAgentSnapshot: id => snapshots.get(id),
    saveAgentSnapshot: snapshot => snapshots.set(snapshot.localProductId, structuredClone(snapshot)),
  });
  return { core, snapshots, detail: () => detail, preparationCalls: () => preparationCalls };
}

test("历史暂停在只读刷新时变为确认动作，确认剔除后自动重核，拒绝后保持停止", async () => {
  const confirmed = harness();
  const waiting = await confirmed.core.get("product");
  assert.equal(waiting.run?.status, "waiting_input");
  assert.match(waiting.pendingInput?.questions[0]?.label ?? "", /确认后.*剔除所有绑定为「冈仁波齐」/);
  assert.deepEqual(waiting.pendingInput?.questions[0]?.options?.map(item => item.id), [
    DOMESTIC_SHORT_POI_REMOVE_OPTION, DOMESTIC_SHORT_POI_KEEP_OPTION,
  ]);
  const requestId = waiting.pendingInput!.id;
  const questionId = waiting.pendingInput!.questions[0]!.id;
  const removed = await confirmed.core.respond("product", {
    requestId, answers: { [questionId]: DOMESTIC_SHORT_POI_REMOVE_OPTION },
  });
  assert.equal((confirmed.detail().product.itinerary as Array<{ spots: unknown[] }>).reduce((sum, day) => sum + day.spots.length, 0), 2);
  assert.equal(removed.run?.status, "running", "剔除后应自动开始新方案核对，不再等待用户点击继续");
  assert.notEqual(removed.run?.id, "run");
  assert.equal((removed.events.find(event => event.id === "approval-event")?.data?.approval as AgentApproval).status, "invalidated");
  assert.equal(removed.events.some(event => event.runId === removed.run?.id
    && event.type === "user" && event.data?.decisionDrivenRecheck === true), true);
  assert.match(removed.events.at(-2)?.content ?? "", /正在自动重新核对调整后的方案/);
  await confirmed.core.idle("product");
  const rechecked = await confirmed.core.get("product");
  assert.equal(rechecked.run?.status, "waiting_approval");
  assert.equal(rechecked.pendingApproval?.status, "pending");
  assert.notEqual(rechecked.pendingApproval?.id, "approval");
  assert.deepEqual(rechecked.pendingApproval?.scope, ["vbk.write_phase:itinerary"]);

  const kept = harness();
  const keepWaiting = await kept.core.get("product");
  const keepQuestion = keepWaiting.pendingInput!.questions[0]!;
  const paused = await kept.core.respond("product", {
    requestId: keepWaiting.pendingInput!.id,
    answers: { [keepQuestion.id]: DOMESTIC_SHORT_POI_KEEP_OPTION },
  });
  assert.equal(paused.run?.status, "paused");
  assert.equal(kept.preparationCalls(), 0, "暂不剔除不能进入产品变更流程");
  assert.equal((kept.detail().product.itinerary as Array<{ spots: unknown[] }>).reduce((sum, day) => sum + day.spots.length, 0), 5);
  assert.match(paused.events.at(-1)?.content ?? "", /保留「冈仁波齐」.*保持停止/);
});
