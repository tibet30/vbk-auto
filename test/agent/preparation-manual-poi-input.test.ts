import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentCore } from "../../src/main/agent/core.js";
import { VbkDatabase } from "../../src/main/infrastructure/database/database.js";
import { enrichItineraryPois } from "../../src/main/planning/poi-enrichment.js";
import type { OrchestratorRuntime } from "../../src/main/planning/types.js";
import { nextPreparationLoopDecision } from "../../src/main/agent/core-preparation.js";
import { resolvedProductQuestions } from "../../src/main/agent/pending-question-reconciliation.js";
import { PRODUCT_PREPARATION_INSTRUCTION } from "../../src/main/agent/preparation-run.js";
import { buildProductSnapshot } from "../../src/main/infrastructure/database/parts/product-draft.js";
import type { AgentSnapshot, ProductDetail } from "../../src/shared/contracts.js";

function product(detail = "未找到对应的 VBK POI，已保留原景点和原行程位置；请确认景点名称或手动录入 POI"): ProductDetail {
  const value = buildProductSnapshot({ destination: "潮州", days: 1, productForm: "privateTour" });
  Object.assign(value.product.basicInfo!, { province: "广东", subtitle: "潮州一日私家团", operationNotes: "按用户日程安排" });
  Object.assign(value.product.operations!, { pickupCity: "潮州", transport: "charter" });
  value.product.itinerary = [{ day: 1, title: "潮州古城", description: "游览广济桥", hotel: "无", meals: "自理", spots: [{ name: "广济桥", poiName: null, poiId: null }] }];
  value.researchTasks = [{ id: "poi", label: "核查 广济桥 的 VBK POI 映射", type: "vbk", state: "researching", status: "queued", detail, evidence: [] }];
  return value;
}

function snapshot(id: string): AgentSnapshot {
  return { localProductId: id, run: { id: "run", status: "running", intentVersion: "v", createdAt: "now", updatedAt: "now" }, events: [
    { id: "user", runId: "run", type: "user", content: PRODUCT_PREPARATION_INSTRUCTION, createdAt: "now" },
  ] };
}

function afterTwoAttempts(current: ProductDetail) {
  const value = snapshot(current.id);
  const deps = { tools: [], accountFor: async () => ({ accountKey: "a", productVersion: "v" }), preparationProduct: () => current };
  const first = nextPreparationLoopDecision(deps, value);
  assert.equal(first.kind, "execute");
  for (const index of [1, 2]) value.events.push({ id: `call-${index}`, runId: "run", type: "tool_call", content: first.action.name, createdAt: "now", data: {
    toolCallId: `call-${index}`, name: first.action.name, deterministicPreparation: true, progressKey: first.action.progressKey,
  } } as never);
  return { value, deps, first };
}

test("两次真实未命中后聚合询问，技术失败和已有 OR 候选不问", () => {
  const current = product(); const prepared = afterTwoAttempts(current);
  const manual = nextPreparationLoopDecision(prepared.deps, prepared.value);
  assert.equal(manual.kind, "askPoiInput");
  assert.match(manual.input.question.label, /第1天「广济桥」/);
  assert.match(manual.input.question.label, /原景点=准确名称/);
  assert.match(manual.input.question.label, /产品审查→每日行程→待手动配置 POI/);
  assert.match(manual.input.question.label, /运营.*手动删除.*Agent 不会代删/);

  const technical = afterTwoAttempts(product("查询超时，稍后重试"));
  assert.equal(nextPreparationLoopDecision(technical.deps, technical.value).kind, "model");
  const historicalAutoConfirm = product();
  historicalAutoConfirm.researchTasks[0]!.status = "succeeded";
  historicalAutoConfirm.researchTasks[0]!.state = "confirmed";
  const historical = afterTwoAttempts(historicalAutoConfirm);
  assert.equal(nextPreparationLoopDecision(historical.deps, historical.value).kind, "askPoiInput");
  const receiptButPresent = product();
  receiptButPresent.product.manualReview = { itinerarySpotRemovals: [{ day: 1, name: "广济桥", removedAt: "2026-10-04T00:00:00.000Z" }] };
  const stillNeedsPoi = afterTwoAttempts(receiptButPresent);
  assert.equal(nextPreparationLoopDecision(stillNeedsPoi.deps, stillNeedsPoi.value).kind, "askPoiInput");
  const alternate = product();
  alternate.product.itinerary![0]!.spots = [
    { name: "广济桥", relation: "or", timeOfDay: "morning", poiName: null, poiId: null },
    { name: "开元寺", relation: "or", timeOfDay: "morning", poiName: "开元寺", poiId: 9 },
  ];
  const orCase = afterTwoAttempts(alternate);
  const unresolvedAlternative = nextPreparationLoopDecision(orCase.deps, orCase.value);
  assert.equal(unresolvedAlternative.kind, "askPoiInput");
  if (unresolvedAlternative.kind === "askPoiInput") assert.match(unresolvedAlternative.input.question.label, /广济桥/);

  const separateGroup = product();
  separateGroup.researchTasks[0]!.label = "核查 广济桥 或 牌坊街 的 VBK POI 映射";
  separateGroup.product.itinerary![0]!.spots = [
    { name: "广济桥", relation: "or", timeOfDay: "morning", poiName: null, poiId: null },
    { name: "开元寺", relation: "or", timeOfDay: "morning", poiName: "开元寺", poiId: 9 },
    { name: "午间休整", kind: "other", relation: "and", timeOfDay: "morning", poiName: null, poiId: null },
    { name: "牌坊街", relation: "or", timeOfDay: "morning", poiName: null, poiId: null },
  ];
  const separatelyPrepared = afterTwoAttempts(separateGroup);
  const separate = nextPreparationLoopDecision(separatelyPrepared.deps, separatelyPrepared.value);
  assert.equal(separate.kind, "askPoiInput");
  assert.match(separate.input.question.label, /牌坊街/);
});

test("真实 no-match enrichment 更新 queued canonical task 后进入人工确认", async () => {
  const dataPath = mkdtempSync(path.join(tmpdir(), "vbk-poi-manual-input-"));
  const current = product(); current.researchTasks = [];
  const db = new VbkDatabase(dataPath);
  try {
    db.importProductSnapshot(current);
    db.addResearchTask(current.id, { label: "核查 广济桥 的 VBK POI 映射", type: "vbk", detail: "先前通用核查" });
    const key = "vbk::核查 广济桥 的 VBK POI 映射";
    const runtime = {
      suggestPoi: async () => null,
      loadCurrentProduct: async (id: string) => db.getProduct(id)!.product,
      addResearchTask: async (id: string, task: { label: string; type: "vbk"; detail: string }) => db.addResearchTask(id, task),
    } as unknown as OrchestratorRuntime;
    const proposals = await enrichItineraryPois({ localProductId: current.id, destination: "潮州", runtime, persistedTaskKeys: new Set([key]) });
    assert.deepEqual(proposals, []);
    const persisted = db.getProduct(current.id)!;
    assert.equal(persisted.researchTasks[0]?.status, "queued");
    assert.match(persisted.researchTasks[0]?.detail ?? "", /未找到对应的 VBK POI/);
    const prepared = afterTwoAttempts(persisted);
    const decision = nextPreparationLoopDecision(prepared.deps, prepared.value);
    assert.equal(decision.kind, "askPoiInput");
    assert.match(decision.input.question.label, /第1天「广济桥」/);
  } finally {
    db.close();
    rmSync(dataPath, { recursive: true, force: true });
  }
});

function automaticPoiAnswer(input: any, value = "保留原地点，查询同日区域锚点") {
  if (input.tools.length) return undefined;
  const payload = JSON.parse(input.messages.at(-1).content);
  return { content: JSON.stringify(Object.fromEntries(payload.questions.map((question: { id: string }) => [question.id, value]))) };
}

test("多个未命中 POI 由 AI 聚合回答，并保留原顺序和 OR 关系", async () => {
  const current = product(); const saved = new Map<string, AgentSnapshot>();
  current.product.itinerary![0]!.spots = [
    { name: "广济桥", relation: "or", timeOfDay: "morning", poiName: null, poiId: null },
    { name: "开元寺", relation: "or", timeOfDay: "morning", poiName: null, poiId: null },
  ];
  current.researchTasks[0]!.label = "核查 广济桥 或 开元寺 的 VBK POI 映射";
  const core = new AgentCore({
    model: { complete: async (input) => automaticPoiAnswer(input) ?? { content: "真实检索无匹配" } },
    tools: [{ name: "resolve_itinerary_pois", description: "resolve", parameters: {}, write: true, requiresApproval: false, execute: async () => ({ content: "no match" }) }],
    accountFor: async () => ({ accountKey: "a", productVersion: "v" }), preparationProduct: () => current,
  }, { getAgentSnapshot: (id) => saved.get(id), saveAgentSnapshot: (item) => saved.set(item.localProductId, structuredClone(item)) });
  await core.send(current.id, PRODUCT_PREPARATION_INSTRUCTION); await core.idle(current.id);
  const waiting = await core.get(current.id);
  assert.equal(waiting.pendingInput, undefined);
  assert.equal(waiting.events.some(event => event.type === "input_request"), false);
  const answer = waiting.events.find(event => event.data?.automaticProductInput === true);
  assert.match(JSON.stringify(answer?.data?.questions), /广济桥.*开元寺/);
  assert.deepEqual(current.product.itinerary![0]!.spots!.map((spot) => [spot.name, spot.relation, spot.timeOfDay]), [
    ["广济桥", "or", "morning"], ["开元寺", "or", "morning"],
  ]);
});

test("回答后模型先查询再绑定原槽位，耗尽不会重复提问", async () => {
  const current = product(); const saved = new Map<string, AgentSnapshot>(); const calls: string[] = [];
  const outputs = [
    { toolCalls: [{ id: "query", name: "query_poi", arguments: { keyword: "广济桥景区" } }] },
    { toolCalls: [{ id: "select", name: "select_itinerary_poi", arguments: { day: 1, spotName: "广济桥", poiId: 101 } }] },
    { content: "已绑定。" },
  ];
  const core = new AgentCore({
    model: { complete: async (input) => automaticPoiAnswer(input) ?? outputs.shift() ?? { content: "done" } },
    tools: [
      { name: "resolve_itinerary_pois", description: "resolve", parameters: {}, write: true, requiresApproval: false, execute: async () => { calls.push("resolve"); return { content: "no match" }; } },
      { name: "query_poi", description: "query", parameters: {}, execute: async () => { calls.push("query"); return { content: "found 101" }; } },
      { name: "select_itinerary_poi", description: "select", parameters: {}, write: true, requiresApproval: false, execute: async () => { calls.push("select"); const spot = current.product.itinerary![0]!.spots![0]!; spot.poiName = "广济桥景区"; spot.poiId = 101; return { content: "bound" }; } },
    ], accountFor: async () => ({ accountKey: "a", productVersion: "v" }), preparationProduct: () => current,
    requiresCompletionVerification: () => true, finishVerified: async () => ({ verified: true }),
  }, { getAgentSnapshot: (id) => saved.get(id), saveAgentSnapshot: (item) => saved.set(item.localProductId, structuredClone(item)) });
  await core.send(current.id, PRODUCT_PREPARATION_INSTRUCTION); await core.idle(current.id);
  const done = await core.get(current.id);
  assert.deepEqual(calls, ["resolve", "resolve", "query", "select"], JSON.stringify(done.events.map((event) => ({ type: event.type, content: event.content, data: event.data }))));
  assert.equal(done.events.some((event) => event.type === "input_request"), false);
  assert.notEqual(done.run?.status, "paused");
});

test("同一人工确认的模型窗口耗尽后暂停，不会再次询问", () => {
  const current = product(); const prepared = afterTwoAttempts(current);
  const asked = nextPreparationLoopDecision(prepared.deps, prepared.value);
  assert.equal(asked.kind, "askPoiInput");
  prepared.value.events.push(
    { id: "ask", runId: "run", type: "tool_call", content: "ask_user", createdAt: "now", data: { toolCallId: "ask", manualPoiInput: true, progressKey: asked.action.progressKey, poiSlotKey: asked.input.key, arguments: { questions: [asked.input.question] } } } as never,
    { id: "input", runId: "run", type: "input_request", content: "补充名称", createdAt: "now", data: { toolCallId: "ask", request: { id: "request", questions: [asked.input.question] } } } as never,
    { id: "answer", runId: "run", type: "tool_result", content: "广济桥景区", createdAt: "now", data: { toolCallId: "ask", answers: { [asked.input.question.id]: "广济桥景区" } } } as never,
  );
  current.product.itinerary![0]!.hotelCandidates = [{ hotelId: 7, hotelName: "潮州酒店", diamond: 5, score: 4.8, distanceKm: 1, cityName: "潮州", anchorName: "广济桥", anchorCityId: 445 }];
  const afterHotelChange = nextPreparationLoopDecision(prepared.deps, prepared.value);
  assert.equal(afterHotelChange.kind, "model");
  assert.equal(afterHotelChange.manualPoiModelWindow, true);
  assert.notEqual(afterHotelChange.action?.progressKey, asked.action.progressKey);
  for (const index of [1, 2, 3]) prepared.value.events.push({ id: `repair-${index}`, runId: "run", type: "status", content: "模型查询", createdAt: "now", data: {
    manualPoiModelWindow: true, progressKey: asked.action.progressKey, poiSlotKey: asked.input.key,
  } } as never);
  const exhausted = nextPreparationLoopDecision(prepared.deps, prepared.value);
  assert.equal(exhausted.kind, "pause");
  assert.match(exhausted.reason, /待手动配置 POI/);
});

test("手动保存要求每个命名 OR 景点都有 POI，other/free 不阻碍", () => {
  const question = { id: "manual", label: "待手动配置 POI", kind: "text" as const, required: true };
  const data = { itinerary: [{ spots: [
    { name: "景点 A", relation: "or", timeOfDay: "morning", poiName: "A", poiId: 1 },
    { name: "景点 B", relation: "or", timeOfDay: "morning", poiName: null, poiId: null },
    { name: "接送", kind: "other", relation: "and", timeOfDay: "morning", poiName: null, poiId: null },
    { name: "景点 C", relation: "or", timeOfDay: "morning", poiName: null, poiId: null },
    { name: "景点 D", relation: "or", timeOfDay: "morning", poiName: null, poiId: null },
    { name: "自由活动", kind: "free", poiName: null, poiId: null },
  ] }] };
  assert.equal(resolvedProductQuestions(data, [question]).length, 0);
  const secondGroup = data.itinerary[0]!.spots[3] as { poiName: string; poiId: number };
  secondGroup.poiName = "C"; secondGroup.poiId = 3;
  assert.equal(resolvedProductQuestions(data, [question]).length, 0);
  const firstGroup = data.itinerary[0]!.spots[1] as { poiName: string; poiId: number };
  const fourth = data.itinerary[0]!.spots[4] as { poiName: string; poiId: number };
  firstGroup.poiName = "B"; firstGroup.poiId = 2; fourth.poiName = "D"; fourth.poiId = 4;
  assert.equal(resolvedProductQuestions(data, [question])[0]?.id, "manual");
});


test("真实 Core 历史 POI 输入即使仅局部保存也转交 AI，不等待运营", async () => {
  const question = { id: "manual-poi", label: "待手动配置 POI", kind: "text" as const, required: true };
  const data = { itinerary: [{ spots: [
    { name: "景点 A", relation: "or", timeOfDay: "morning", poiName: "A", poiId: 1 },
    { name: "景点 B", relation: "or", timeOfDay: "morning", poiName: null, poiId: null },
    { name: "送站", kind: "other", relation: "and", timeOfDay: "morning", poiName: null, poiId: null },
    { name: "景点 C", relation: "or", timeOfDay: "morning", poiName: null, poiId: null },
    { name: "景点 D", relation: "or", timeOfDay: "morning", poiName: null, poiId: null },
    { name: "自由活动", kind: "free", poiName: null, poiId: null },
  ] }] };
  let saved: AgentSnapshot = { localProductId: "saved", run: { id: "run", status: "waiting_input", createdAt: "now", updatedAt: "now" },
    pendingInput: { id: "request", questions: [question], createdAt: "now" }, events: [
      { id: "user", runId: "run", type: "user", content: PRODUCT_PREPARATION_INSTRUCTION, createdAt: "now" },
      { id: "ask", runId: "run", type: "tool_call", content: "ask_user", createdAt: "now", data: { toolCallId: "ask", name: "ask_user", arguments: { questions: [question] } } },
      { id: "input", runId: "run", type: "input_request", content: "待手动配置", createdAt: "now", data: { toolCallId: "ask", request: { id: "request", questions: [question], createdAt: "now" } } },
    ] };
  const core = new AgentCore({
    model: { complete: async () => ({ content: "已继续" }) }, tools: [], accountFor: async () => ({ accountKey: "a", productVersion: "v" }),
    resolvedPendingQuestions: (_id, questions) => resolvedProductQuestions(data, questions),
  }, { getAgentSnapshot: () => saved, saveAgentSnapshot: (next) => { saved = structuredClone(next); } });
  const partial = await core.reconcilePendingInput("saved");
  assert.equal(partial.run?.status, "running");
  assert.equal(partial.pendingInput, undefined);
  assert.equal(partial.events.some(event => event.data?.automaticInputRedirect === true), true);
  await core.idle("saved");
  assert.equal((await core.get("saved")).pendingInput, undefined);
});

test("别名窗口暂停后仅在全部手动 POI 保存时自动恢复，普通暂停不恢复", async () => {
  const current = product(); const saved = new Map<string, AgentSnapshot>();
  current.product.itinerary![0]!.spots = [
    { name: "景点 A", relation: "or", timeOfDay: "morning", poiName: null, poiId: null },
    { name: "景点 B", relation: "or", timeOfDay: "morning", poiName: null, poiId: null },
    { name: "接送", kind: "other", relation: "and", timeOfDay: "morning", poiName: null, poiId: null },
    { name: "景点 C", relation: "or", timeOfDay: "morning", poiName: null, poiId: null },
    { name: "景点 D", relation: "or", timeOfDay: "morning", poiName: null, poiId: null },
  ];
  current.researchTasks = [
    { id: "ab", label: "核查 景点 A 或 景点 B 的 VBK POI 映射", type: "vbk", status: "queued", state: "researching", detail: "未找到对应的 VBK POI", evidence: [] },
    { id: "cd", label: "核查 景点 C 或 景点 D 的 VBK POI 映射", type: "vbk", status: "queued", state: "researching", detail: "未找到对应的 VBK POI", evidence: [] },
  ];
  const outputs = [{ content: "请查询。" }, { content: "请继续查询。" }, { content: "仍需查询。" }];
  const core = new AgentCore({
    model: { complete: async (input) => automaticPoiAnswer(input) ?? outputs.shift() ?? { content: "不会继续调用" } },
    tools: [{ name: "resolve_itinerary_pois", description: "resolve", parameters: {}, write: true, requiresApproval: false, execute: async () => ({ content: "no match" }) }],
    accountFor: async () => ({ accountKey: "a", productVersion: "v" }), preparationProduct: () => current,
  }, { getAgentSnapshot: (id) => saved.get(id), saveAgentSnapshot: (item) => saved.set(item.localProductId, structuredClone(item)) });
  await core.send(current.id, PRODUCT_PREPARATION_INSTRUCTION); await core.idle(current.id);
  const blocked = await core.get(current.id);
  assert.equal(blocked.run?.status, "paused");
  assert.equal(blocked.pendingInput, undefined);
  assert.equal(blocked.events.at(-1)?.data?.manualPoiBlocked, true);

  const spots = current.product.itinerary![0]!.spots!;
  spots[0]!.poiName = "景点A新名"; spots[0]!.poiId = 101;
  const partial = await core.reconcilePendingInput(current.id);
  assert.equal(partial.run?.status, "paused");
  assert.equal(partial.events.some((event) => event.data?.manualPoiBlockedResolved === true), false);

  spots[3]!.poiName = "景点C新名"; spots[3]!.poiId = 103;
  spots[1]!.poiName = "景点B新名"; spots[1]!.poiId = 102;
  spots[4]!.poiName = "景点D新名"; spots[4]!.poiId = 104;
  const resumed = await core.reconcilePendingInput(current.id);
  assert.equal(resumed.run?.status, "running");
  assert.equal(resumed.events.at(-1)?.data?.manualPoiBlockedResolved, true);

  for (const [name, guard] of [
    ["uncertain", (snapshot: AgentSnapshot) => { snapshot.uncertainWrite = { toolCallId: "write", message: "等待核对", createdAt: "now" }; }],
    ["remote", (snapshot: AgentSnapshot) => snapshot.events.push({ id: "remote", runId: snapshot.run!.id, type: "tool_result", content: "已远端写入", createdAt: "now", data: { toolCallId: "write", remoteWrite: true } })],
    ["approved", (snapshot: AgentSnapshot) => snapshot.events.push({ id: "approved", runId: snapshot.run!.id, type: "approval", content: "已确认", createdAt: "now", data: { approval: { status: "approved", intentVersion: snapshot.run!.intentVersion } } })],
  ] as const) {
    const guarded = structuredClone(blocked); guard(guarded);
    const guardedCore = new AgentCore({
      model: { complete: async () => ({ content: "不应启动" }) }, tools: [], accountFor: async () => ({ accountKey: "a", productVersion: "v" }), preparationProduct: () => current,
    }, { getAgentSnapshot: () => guarded, saveAgentSnapshot: (item) => Object.assign(guarded, structuredClone(item)) });
    assert.equal((await guardedCore.reconcilePendingInput(current.id)).run?.status, "paused", name);
  }

  const voluntary = structuredClone(blocked);
  voluntary.events[voluntary.events.length - 1]!.data = { status: "paused" };
  const voluntaryCore = new AgentCore({
    model: { complete: async () => ({ content: "不应启动" }) }, tools: [], accountFor: async () => ({ accountKey: "a", productVersion: "v" }), preparationProduct: () => current,
  }, { getAgentSnapshot: () => voluntary, saveAgentSnapshot: (item) => Object.assign(voluntary, structuredClone(item)) });
  const untouched = await voluntaryCore.reconcilePendingInput(current.id);
  assert.equal(untouched.run?.status, "paused");
  assert.equal(untouched.events.some((event) => event.data?.manualPoiBlockedResolved === true), false);
});

test("一次多点回答按剩余槽位继承窗口，新增或改名不继承", async () => {
  const current = product(); const saved = new Map<string, AgentSnapshot>(); const calls: string[] = [];
  current.product.itinerary![0]!.spots = [
    { name: "景点 A", relation: "and", timeOfDay: "morning", poiName: null, poiId: null },
    { name: "景点 B", relation: "and", timeOfDay: "afternoon", poiName: null, poiId: null },
  ];
  current.researchTasks = [
    { id: "a", label: "核查 景点 A 的 VBK POI 映射", type: "vbk", status: "queued", state: "researching", detail: "未找到对应的 VBK POI", evidence: [] },
    { id: "b", label: "核查 景点 B 的 VBK POI 映射", type: "vbk", status: "queued", state: "researching", detail: "未找到对应的 VBK POI", evidence: [] },
  ];
  const outputs = [
    { toolCalls: [{ id: "query-a", name: "query_poi", arguments: { keyword: "别名A" } }] },
    { toolCalls: [{ id: "select-a", name: "select_itinerary_poi", arguments: { day: 1, spotName: "景点 A", poiId: 101 } }] },
    { toolCalls: [{ id: "query-b", name: "query_poi", arguments: { keyword: "别名B" } }] },
    { toolCalls: [{ id: "select-b", name: "select_itinerary_poi", arguments: { day: 1, spotName: "景点 B", poiId: 102 } }] },
    { content: "已完成" },
  ];
  const core = new AgentCore({
    model: { complete: async (input) => automaticPoiAnswer(input) ?? outputs.shift() ?? { content: "done" } },
    tools: [
      { name: "resolve_itinerary_pois", description: "resolve", parameters: {}, write: true, requiresApproval: false, execute: async () => { calls.push("resolve"); return { content: "no match" }; } },
      { name: "query_poi", description: "query", parameters: {}, execute: async (args) => { calls.push(`query:${args.keyword}`); return { content: "found" }; } },
      { name: "select_itinerary_poi", description: "select", parameters: {}, write: true, requiresApproval: false, execute: async (args) => {
        calls.push(`select:${args.spotName}`); const spot = current.product.itinerary![0]!.spots!.find((item) => item.name === args.spotName)!;
        spot.poiName = String(args.spotName).replace("景点 ", "别名"); spot.poiId = Number(args.poiId); return { content: "bound" };
      } },
    ], accountFor: async () => ({ accountKey: "a", productVersion: "v" }), preparationProduct: () => current,
  }, { getAgentSnapshot: (id) => saved.get(id), saveAgentSnapshot: (item) => saved.set(item.localProductId, structuredClone(item)) });
  await core.send(current.id, PRODUCT_PREPARATION_INSTRUCTION); await core.idle(current.id);
  const done = await core.get(current.id);
  assert.deepEqual(calls, ["resolve", "resolve", "query:别名A", "select:景点 A", "query:别名B", "select:景点 B"]);
  assert.equal(done.events.filter((event) => event.type === "input_request").length, 0);
  assert.deepEqual(current.product.itinerary![0]!.spots!.map((spot) => [spot.name, spot.relation, spot.timeOfDay]), [
    ["景点 A", "and", "morning"], ["景点 B", "and", "afternoon"],
  ]);

  const changed = product(); changed.product.itinerary![0]!.spots = [{ name: "景点 A", poiName: null, poiId: null }, { name: "景点 B", poiName: null, poiId: null }];
  changed.researchTasks = current.researchTasks.map((task) => ({ ...task, state: "researching", status: "queued" }));
  const prepared = afterTwoAttempts(changed); const asked = nextPreparationLoopDecision(prepared.deps, prepared.value);
  assert.equal(asked.kind, "askPoiInput");
  prepared.value.events.push(
    { id: "ask", runId: "run", type: "tool_call", content: "ask_user", createdAt: "now", data: { toolCallId: "ask", manualPoiInput: true, poiSlotKey: asked.input.key, poiSlots: asked.input.slots, arguments: { questions: [asked.input.question] } } } as never,
    { id: "input", runId: "run", type: "input_request", content: "输入", createdAt: "now", data: { toolCallId: "ask", request: { id: "request", questions: [asked.input.question] } } } as never,
    { id: "answer", runId: "run", type: "tool_result", content: "回答", createdAt: "now", data: { toolCallId: "ask", answers: { [asked.input.question.id]: "别名" } } } as never,
  );
  changed.product.itinerary![0]!.spots![1]!.name = "景点 B 新名";
  changed.researchTasks[1]!.label = "核查 景点 B 新名 的 VBK POI 映射";
  assert.equal(nextPreparationLoopDecision(prepared.deps, prepared.value).kind, "execute");
  changed.product.itinerary![0]!.spots!.push({ name: "景点 C", poiName: null, poiId: null });
  changed.researchTasks.push({ id: "c", label: "核查 景点 C 的 VBK POI 映射", type: "vbk", status: "queued", state: "researching", detail: "未找到对应的 VBK POI", evidence: [] });
  assert.equal(nextPreparationLoopDecision(prepared.deps, prepared.value).kind, "execute");
});
