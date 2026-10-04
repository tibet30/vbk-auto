import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentCore } from "../../src/main/agent/core.js";
import { ProductMutationService } from "../../src/main/application/product-mutation-service.js";
import { VbkDatabase } from "../../src/main/infrastructure/database/database.js";
import { buildProductSnapshot } from "../../src/main/infrastructure/database/parts/product-draft.js";
import { PRODUCT_PREPARATION_INSTRUCTION } from "../../src/main/agent/preparation-run.js";
import { nextPreparationLoopDecision } from "../../src/main/agent/core-preparation.js";
import { evaluatePreparationCompletion } from "../../src/main/planning/preparation-completion.js";
import type { AgentCoreDependencies, AgentModelInput, AgentModelResult } from "../../src/main/agent/types.js";
import type { AgentSnapshot, ProductDetail } from "../../src/shared/contracts.js";

function baseProduct(): ProductDetail {
  const value = buildProductSnapshot({ destination: "潮州", days: 2, productForm: "privateTour" });
  Object.assign(value.product.basicInfo!, { province: "广东", subtitle: "潮州两日私家团", operationNotes: "按用户日程安排" });
  Object.assign(value.product.operations!, { pickupCity: "潮州", transport: "charter" });
  return value;
}

function completeItinerary(product: ProductDetail, verified = true) {
  product.product.itinerary = [
    { day: 1, title: "潮州古城", description: "游览广济桥", hotel: "无", meals: "自理", spots: [{ name: "广济桥", poiName: verified ? "广济桥" : null, poiId: verified ? 101 : null }] },
    { day: 2, title: "南澳海岸", description: "游览南澳大桥", hotel: "无", meals: "自理", spots: [{ name: "南澳大桥", poiName: verified ? "南澳大桥" : null, poiId: verified ? 102 : null }] },
  ];
}

function harness(product: ProductDetail, modelResults: AgentModelResult[] = [{ content: "本地行程已保存。" }]) {
  const snapshots = new Map<string, AgentSnapshot>();
  const calls: string[] = [];
  const deps: AgentCoreDependencies = {
    model: { complete: async () => modelResults.shift() ?? { content: "本地规划仍有缺项。" } },
    tools: [],
    accountFor: async () => ({ accountKey: "local", productVersion: "v1" }),
    preparationProduct: () => product,
    requiresCompletionVerification: () => true,
    finishVerified: async () => ({ verified: true }),
  };
  const core = new AgentCore(deps, {
    getAgentSnapshot: (id) => snapshots.get(id),
    saveAgentSnapshot: (snapshot) => snapshots.set(snapshot.localProductId, structuredClone(snapshot)),
  });
  return { core, deps, calls, snapshots };
}

test("AgentCore.send 在模型前自动生成缺失 itinerary，并记录可回读节点", async () => {
  const product = baseProduct();
  product.researchTasks = [{ id: "stale", label: "核查 南澳大桥 的 VBK POI 映射", type: "vbk", state: "researching", status: "queued", evidence: [] }];
  const { core, deps, calls } = harness(product);
  deps.tools = [{ name: "generate_product_module", description: "generate", parameters: {}, write: true, requiresApproval: false, execute: async () => {
    calls.push("generate");
    completeItinerary(product);
    product.researchTasks[0]!.state = "confirmed";
    return { content: "itinerary saved" };
  } }];

  await core.send(product.id, PRODUCT_PREPARATION_INSTRUCTION);
  await core.idle(product.id);
  const snapshot = await core.get(product.id);
  assert.deepEqual(calls, ["generate"]);
  assert.equal(snapshot.events.some((event) => event.type === "input_request"), false);
  assert.ok(snapshot.events.some((event) => event.data?.deterministicPreparation === true
    && event.data?.node === "itineraryDraft" && event.data?.name === "generate_product_module"));
});

test("已有结构的未核验 POI 自动 resolve，而不重生行程", async () => {
  const product = baseProduct();
  completeItinerary(product, false);
  product.researchTasks = [{ id: "poi", label: "核查 南澳大桥 的 VBK POI 映射", type: "vbk", state: "researching", status: "queued", evidence: [] }];
  const { core, deps, calls } = harness(product);
  deps.tools = [{ name: "resolve_itinerary_pois", description: "resolve", parameters: {}, write: true, requiresApproval: false, execute: async () => {
    calls.push("resolve");
    completeItinerary(product);
    product.researchTasks[0]!.state = "confirmed";
    return { content: "POI saved" };
  } }];

  await core.send(product.id, PRODUCT_PREPARATION_INSTRUCTION);
  await core.idle(product.id);
  assert.deepEqual(calls, ["resolve"]);
});

test("无进展时最多自动两次，给模型一次修复窗口后暂停而不追问继续", async () => {
  const product = baseProduct();
  const { core, deps, calls } = harness(product, [{ toolCalls: [{ id: "repair", name: "patch_product", arguments: {} }] }]);
  deps.tools = [
    { name: "generate_product_module", description: "generate", parameters: {}, write: true, requiresApproval: false, execute: async () => { calls.push("generate"); return { content: "still missing" }; } },
    { name: "patch_product", description: "repair", parameters: {}, write: true, requiresApproval: false, execute: async () => { calls.push("patch"); return { content: "no structural change" }; } },
  ];

  await core.send(product.id, PRODUCT_PREPARATION_INSTRUCTION);
  await core.idle(product.id);
  const snapshot = await core.get(product.id);
  assert.deepEqual(calls, ["generate", "generate", "patch"]);
  assert.equal(snapshot.run?.status, "paused");
  assert.match(snapshot.events.at(-1)?.content ?? "", /自动尝试 2 次且模型修复一次/);
  assert.equal(snapshot.events.some((event) => event.type === "input_request"), false);
});

test("模型修复保存有效行程后，director 刷新语义进度并继续 POI", async () => {
  const product = baseProduct();
  const { core, deps, calls } = harness(product);
  const modelInputs: AgentModelInput[] = [];
  deps.model = { complete: async (input) => {
    modelInputs.push(input);
    return modelInputs.length === 1
      ? { toolCalls: [{ id: "repair", name: "patch_product", arguments: {} }] }
      : { content: "修复已保存。" };
  } };
  deps.tools = [
    { name: "generate_product_module", description: "generate", parameters: {}, write: true, requiresApproval: false,
      execute: async () => { calls.push("generate"); return { content: "still missing" }; } },
    { name: "patch_product", description: "repair", parameters: {}, write: true, requiresApproval: false,
      execute: async () => { calls.push("patch"); completeItinerary(product, false); return { content: "saved valid structure" }; } },
    { name: "resolve_itinerary_pois", description: "poi", parameters: {}, write: true, requiresApproval: false,
      execute: async () => { calls.push("poi"); completeItinerary(product); return { content: "POI saved" }; } },
  ];
  await core.send(product.id, PRODUCT_PREPARATION_INSTRUCTION);
  await core.idle(product.id);
  const snapshot = await core.get(product.id);
  assert.deepEqual(calls, ["generate", "generate", "patch", "poi"]);
  assert.notEqual(snapshot.run?.status, "paused");
  assert.equal(modelInputs.some((input) => input.messages.some((message) => message.role === "system"
    && /已自动尝试两次/.test(message.content) && /不能只询问是否继续/.test(message.content))), true);
});

test("确定性工具连续抛错两次仍进入一次模型修复窗口", async () => {
  const product = baseProduct();
  let modelCalls = 0;
  const { core, deps, calls } = harness(product, [{ content: "检查最近工具错误后不再重复调用。" }]);
  deps.model = { complete: async () => { modelCalls += 1; return { content: "检查最近工具错误后不再重复调用。" }; } };
  deps.tools = [{ name: "generate_product_module", description: "generate", parameters: {}, write: true, requiresApproval: false,
    execute: async () => { calls.push("generate"); throw new Error("itinerary rejected: locked days"); } }];

  await core.send(product.id, PRODUCT_PREPARATION_INSTRUCTION);
  await core.idle(product.id);
  const snapshot = await core.get(product.id);
  assert.deepEqual(calls, ["generate", "generate"]);
  assert.equal(modelCalls, 1);
  assert.equal(snapshot.run?.status, "paused");
  assert.equal(snapshot.events.some((event) => event.data?.deterministicPreparationModelRepair === true), true);
  assert.equal(snapshot.events.some((event) => /最近结果：工具失败/.test(event.content)), true);
});

test("模型修复中的纯继续问题自动回答，业务替换选择仍等待输入", async () => {
  const product = baseProduct();
  const pure = harness(product, [{ toolCalls: [{ id: "continue", name: "ask_user", arguments: { questions: [{
    id: "repair-next", label: "是否继续重新生成行程", kind: "single", options: [{ id: "continue", label: "继续" }, { id: "stop", label: "停止" }],
  }] } }] }]);
  pure.deps.tools = [{ name: "generate_product_module", description: "generate", parameters: {}, write: true, requiresApproval: false,
    execute: async () => ({ content: "no progress" }) }];
  await pure.core.send(product.id, PRODUCT_PREPARATION_INSTRUCTION);
  await pure.core.idle(product.id);
  const pureSnapshot = await pure.core.get(product.id);
  assert.equal(pureSnapshot.events.some((event) => event.type === "input_request"), false);
  assert.equal(pureSnapshot.events.some((event) => event.data?.defaultAnswers && (event.data.defaultAnswers as Record<string, unknown>)["repair-next"] === "continue"), true);

  const confirm = harness(baseProduct(), [{ toolCalls: [{ id: "confirm", name: "ask_user", arguments: { questions: [{
    id: "repair-confirm", label: "是否继续重试", kind: "confirm",
  }] } }] }]);
  confirm.deps.tools = [{ name: "generate_product_module", description: "generate", parameters: {}, write: true, requiresApproval: false,
    execute: async () => ({ content: "no progress" }) }];
  await confirm.core.send(product.id, PRODUCT_PREPARATION_INSTRUCTION);
  await confirm.core.idle(product.id);
  const confirmSnapshot = await confirm.core.get(product.id);
  assert.equal(confirmSnapshot.events.some((event) => event.type === "input_request"), false);
  assert.equal(confirmSnapshot.events.some((event) => event.data?.defaultAnswers
    && (event.data.defaultAnswers as Record<string, unknown>)["repair-confirm"] === "true"), true);

  const choice = harness(baseProduct(), [{ toolCalls: [{ id: "choice", name: "ask_user", arguments: { questions: [{
    id: "replace-city", label: "是否替换目的地城市", kind: "single", options: [{ id: "continue", label: "继续" }, { id: "replace", label: "替换为汕头" }],
  }] } }] }]);
  choice.deps.tools = [{ name: "generate_product_module", description: "generate", parameters: {}, write: true, requiresApproval: false,
    execute: async () => ({ content: "no progress" }) }];
  await choice.core.send(product.id, PRODUCT_PREPARATION_INSTRUCTION);
  await choice.core.idle(product.id);
  const choiceSnapshot = await choice.core.get(product.id);
  assert.equal(choiceSnapshot.run?.status, "waiting_input");
  assert.equal(choiceSnapshot.pendingInput?.questions[0]?.id, "replace-city");

  const businessChoices = [
    {
      id: "mixed", label: "是否继续修复行程", options: [
        { id: "continue", label: "继续" }, { id: "change", label: "更换为私家包车方案后重试" },
      ],
    },
    {
      id: "hotel-tier", label: "酒店等级调整后重试", options: [
        { id: "downgrade", label: "5钻改4钻后重试" }, { id: "stop", label: "停止" },
      ],
    },
    {
      id: "poi-replace", label: "全未命中 POI，删除或替换后重试", options: [
        { id: "remove", label: "删除无匹配景点后重试" }, { id: "replace", label: "替换为其他景点" },
      ],
    },
  ];
  for (const item of businessChoices) {
    const business = harness(baseProduct(), [{ toolCalls: [{ id: item.id, name: "ask_user", arguments: { questions: [{ ...item, kind: "single" }] } }] }]);
    business.deps.tools = [{ name: "generate_product_module", description: "generate", parameters: {}, write: true, requiresApproval: false,
      execute: async () => ({ content: "no progress" }) }];
    await business.core.send(product.id, PRODUCT_PREPARATION_INSTRUCTION);
    await business.core.idle(product.id);
    const snapshot = await business.core.get(product.id);
    assert.equal(snapshot.run?.status, "waiting_input", item.id);
    assert.equal(snapshot.pendingInput?.questions[0]?.id, item.id);
  }
});

test("隔离 SQLite 经结构、POI、酒店三节点写回后重启仍可读", async () => {
  const dataPath = mkdtempSync(path.join(tmpdir(), "vbk-preparation-director-"));
  let db = new VbkDatabase(dataPath);
  try {
    const initial = baseProduct();
    initial.product.operations!.hotelTier = "当地5钻酒店/-38";
    db.importProductSnapshot(initial);
    const mutations = new ProductMutationService(db);
    const core = new AgentCore({
      model: { complete: async () => ({ content: "本地规划完成。" }) },
      tools: [
        { name: "generate_product_module", description: "generate", parameters: {}, write: true, requiresApproval: false,
        execute: async (_args, context) => {
          const saved = db.getProduct(context.localProductId)!;
          const next = structuredClone(saved.product);
          next.itinerary = [
            { day: 1, title: "潮州古城", description: "游览广济桥", hotel: "潮州5钻酒店", meals: "自理", spots: [{ name: "广济桥", poiName: null, poiId: null }] },
            { day: 2, title: "南澳海岸", description: "游览南澳大桥", hotel: "无", meals: "自理", spots: [{ name: "南澳大桥", poiName: null, poiId: null }] },
          ];
          mutations.replace(context.localProductId, next);
          return { content: "itinerary structure saved and read back" };
        } },
        { name: "resolve_itinerary_pois", description: "poi", parameters: {}, write: true, requiresApproval: false,
          execute: async (_args, context) => {
            const saved = db.getProduct(context.localProductId)!;
            const next = structuredClone(saved.product);
            const days = next.itinerary as Array<{ spots: Array<{ poiName: string | null; poiId: number | null }> }>;
            days[0]!.spots[0]!.poiName = "广济桥"; days[0]!.spots[0]!.poiId = 101;
            days[1]!.spots[0]!.poiName = "南澳大桥"; days[1]!.spots[0]!.poiId = 102;
            mutations.replace(context.localProductId, next);
            return { content: "POI slots saved and read back" };
          } },
        { name: "resolve_itinerary_hotels", description: "hotel", parameters: {}, write: true, requiresApproval: false,
          execute: async (_args, context) => {
            const saved = db.getProduct(context.localProductId)!;
            const next = structuredClone(saved.product);
            const days = next.itinerary as Array<{ hotelCandidates?: unknown[] }>;
            days[0]!.hotelCandidates = [
              { hotelId: 501, hotelName: "潮州金钻酒店", diamond: 5, score: 4.8, distanceKm: 1.2, cityName: "潮州", anchorName: "广济桥", anchorCityId: 445 },
              { hotelId: 502, hotelName: "潮州古城酒店", diamond: 5, score: 4.7, distanceKm: 1.8, cityName: "潮州", anchorName: "广济桥", anchorCityId: 445 },
              { hotelId: 503, hotelName: "潮州府城酒店", diamond: 5, score: 4.6, distanceKm: 2.1, cityName: "潮州", anchorName: "广济桥", anchorCityId: 445 },
            ];
            mutations.replace(context.localProductId, next);
            return { content: "hotel candidates saved and read back" };
          } },
      ],
      accountFor: async () => ({ accountKey: "local", productVersion: "v1" }),
      preparationProduct: (id) => db.getProduct(id),
      requiresCompletionVerification: () => true,
      finishVerified: async () => ({ verified: false, finalApproval: { scope: ["vbk_entry"], summary: "等待最终确认" } }),
    }, db);
    await core.send(initial.id, PRODUCT_PREPARATION_INSTRUCTION);
    await core.idle(initial.id);
    const beforeRestart = db.getAgentSnapshot(initial.id)!;
    assert.deepEqual(beforeRestart.events.filter((event) => event.type === "tool_call" && event.data?.deterministicPreparation === true)
      .map((event) => event.data?.name), ["generate_product_module", "resolve_itinerary_pois", "resolve_itinerary_hotels"]);
    assert.equal(beforeRestart.events.some((event) => event.type === "input_request"), false);
    assert.equal(beforeRestart.run?.status, "waiting_approval");
    db.close();
    db = new VbkDatabase(dataPath);
    const reloaded = db.getProduct(initial.id)!;
    const snapshot = db.getAgentSnapshot(initial.id)!;
    assert.equal(reloaded.product.basicInfo?.meetingCity, "潮州");
    assert.equal(reloaded.product.basicInfo?.destinationCity, "潮州");
    assert.equal(reloaded.product.basicInfo?.days, 2);
    assert.deepEqual(reloaded.product.itinerary?.map((day) => day.title), ["潮州古城", "南澳海岸"]);
    assert.equal(reloaded.product.itinerary?.[0]?.hotelCandidates?.length, 3);
    assert.equal(reloaded.product.itinerary?.[0]?.hotelCandidates?.every((candidate) => candidate.diamond === 5 && candidate.cityName === "潮州"), true);
    const evaluation = evaluatePreparationCompletion(reloaded);
    assert.equal(evaluation.missing.some((label) => /每日行程|POI|酒店候选/.test(label)), false);
    assert.equal(snapshot.run?.status, "waiting_approval");
  } finally {
    db.close();
    rmSync(dataPath, { recursive: true, force: true });
  }
});

test("暂停、审批和不确定写入不触发自动准备动作", async () => {
  const product = baseProduct();
  const snapshot: AgentSnapshot = {
    localProductId: product.id,
    uncertainWrite: { toolCallId: "write", message: "unknown" },
    run: { id: "run", status: "running", intentVersion: 1, createdAt: "now", updatedAt: "now" },
    events: [{ id: "user", runId: "run", type: "user", createdAt: "now", content: PRODUCT_PREPARATION_INSTRUCTION }],
  };
  const decision = nextPreparationLoopDecision({ tools: [], accountFor: async () => ({ accountKey: "a", productVersion: "v" }), preparationProduct: () => product }, snapshot);
  assert.equal(decision.kind, "model");
  const paused = structuredClone(snapshot);
  paused.uncertainWrite = undefined;
  paused.run!.status = "paused";
  assert.equal(nextPreparationLoopDecision({ tools: [], accountFor: async () => ({ accountKey: "a", productVersion: "v" }), preparationProduct: () => product }, paused).kind, "model");
  const approved = structuredClone(snapshot);
  approved.uncertainWrite = undefined;
  approved.pendingApproval = { id: "approval", status: "pending", scope: ["vbk_entry"], summary: "待确认", createdAt: "now", intentVersion: 1 };
  assert.equal(nextPreparationLoopDecision({ tools: [], accountFor: async () => ({ accountKey: "a", productVersion: "v" }), preparationProduct: () => product }, approved).kind, "model");
});
