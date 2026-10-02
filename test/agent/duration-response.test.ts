import assert from "node:assert/strict";
import test from "node:test";
import { AgentCore } from "../../src/main/agent/core.js";
import type { AgentCoreDependencies } from "../../src/main/agent/types.js";
import { repairProductForExplicitInstruction } from "../../src/main/agent/user-instruction-repair.js";
import { extractLockedConstraints } from "../../src/main/agent/prompt-helpers.js";
import { planningWriteContractError } from "../../src/main/planning/itinerary-input-contract.js";
import type { AgentInputRequest, AgentSnapshot, ProductDetail } from "../../src/shared/contracts.js";

function harness(label = "解锁为5天4晚") {
  let detail: ProductDetail = {
    id: "product", name: "成都2天1晚", status: "draft", updatedAt: "x", messages: [], researchTasks: [],
    product: { basicInfo: { days: 2, nights: 1, userIdea: "D1 宽窄巷子，D2 武侯祠，D3 锦里，D4 大熊猫基地，D5 青城山" } },
  };
  let mutations = 0;
  let modelContext = "";
  const request: AgentInputRequest = {
    id: "request", createdAt: "x", questions: [{ id: "days-vs-itinerary", label: "是否改为5天4晚？", kind: "single", required: true,
      options: [{ id: "unlock", label }, { id: "keep", label: "保留当前天数" }] }],
  };
  const snapshots = new Map<string, AgentSnapshot>([["product", {
    localProductId: "product", events: [], pendingInput: request,
    run: { id: "run", status: "waiting_input", intentVersion: "old", createdAt: "x", updatedAt: "x" },
  }]]);
  let sequence = 0;
  const deps: AgentCoreDependencies = {
    tools: [], id: () => `generated-${++sequence}`,
    accountFor: async () => ({ accountKey: "account", productVersion: "version" }),
    productFingerprint: async () => JSON.stringify(detail.product.basicInfo),
    prepareUserInstruction: (_id, content, selection) => {
      const repair = repairProductForExplicitInstruction(detail, content, selection?.selectedLabels, selection?.selectedQuestions);
      if (!repair) return false;
      detail = { ...detail, product: structuredClone(repair.product) };
      mutations++;
      return true;
    },
    contextFor: async () => JSON.stringify({ basicInfo: detail.product.basicInfo, constraints: extractLockedConstraints(detail, detail.messages) }),
    model: { complete: async ({ messages }) => { modelContext = JSON.stringify(messages); return { content: "done" }; } },
    finishVerified: async () => ({ verified: true }),
  };
  const core = new AgentCore(deps, {
    getAgentSnapshot: (id) => snapshots.get(id),
    saveAgentSnapshot: (snapshot) => snapshots.set(snapshot.localProductId, structuredClone(snapshot)),
  });
  return { core, deps, request, snapshots, detail: () => detail, mutations: () => mutations, modelContext: () => modelContext };
}

for (const label of ["解锁为5天4晚", "解除锁定，按5天4晚", "解锁天数为5天4晚"]) {
  test(`validated selected option persists duration before the model: ${label}`, async () => {
    const h = harness(label);
    const beforeIdea = h.detail().product.basicInfo!.userIdea;
    const result = await h.core.respond("product", { requestId: "request", answers: { "days-vs-itinerary": "unlock" } });
    assert.equal(h.detail().product.basicInfo!.days, 5);
    assert.equal(h.detail().product.basicInfo!.nights, 4);
    assert.equal(h.detail().product.basicInfo!.userIdea, beforeIdea);
    assert.equal(extractLockedConstraints(h.detail(), []).days, 5);
    assert.equal(planningWriteContractError(h.detail(), "skeleton", { days: 5 }), undefined);
    assert.match(planningWriteContractError(h.detail(), "skeleton", { days: 2 }) ?? "", /锁定/);
    assert.notEqual(result.run!.intentVersion, "old");
    assert.equal(result.pendingInput, undefined);
    assert.equal(result.events.find((event) => event.type === "user")!.data!.answers &&
      (result.events.find((event) => event.type === "user")!.data!.answers as Record<string, string>)["days-vs-itinerary"], "unlock");
    await h.core.idle("product");
    assert.ok(h.modelContext().includes(label));
    assert.ok(h.modelContext().includes('\\"days\\":5'));
    await h.core.respond("product", { requestId: "request", answers: { "days-vs-itinerary": "unlock" } });
    assert.equal(h.mutations(), 1, "stale repeated submissions do not mutate twice");
  });
}

test("only chosen labels imply changes; question/default/IDs never do", async () => {
  const h = harness();
  h.request.defaultAnswers = { prior: "改成5天4晚" };
  const result = await h.core.respond("product", { requestId: "request", answers: { "days-vs-itinerary": "keep" } });
  assert.equal(h.mutations(), 0);
  assert.equal(result.run!.intentVersion, "old");
  await h.core.idle("product");
  const raw = harness();
  raw.request.questions[0]!.options![0] = { id: "改成5天4晚", label: "继续当前安排" };
  await raw.core.respond("product", { requestId: "request", answers: { "days-vs-itinerary": "改成5天4晚" } });
  assert.equal(raw.mutations(), 0);
  await raw.core.idle("product");
  assert.equal(repairProductForExplicitInstruction(
    h.detail(),
    "",
    ["确认5天4晚"],
    [{ id: "package_preference", label: "行程选择", selectedLabel: "确认5天4晚" }],
  ), undefined);
});

test("invalid, stale or ambiguous duration answers cannot repair", async () => {
  const h = harness();
  await h.core.respond("product", { requestId: "stale", answers: { "days-vs-itinerary": "unlock" } });
  await h.core.respond("product", { requestId: "request", answers: { "days-vs-itinerary": "unknown" } });
  assert.equal(h.mutations(), 0);
  assert.ok(h.snapshots.get("product")!.pendingInput);
  for (const label of ["不要改为5天4晚", "确认5天4晚或6天5晚", "5天4晚只是参考", "按5天6晚", "按61天60晚"]) {
    assert.equal(repairProductForExplicitInstruction(h.detail(), "", [label]), undefined);
  }
  assert.equal(repairProductForExplicitInstruction(h.detail(), "", ["按5天4晚", "按6天5晚"]), undefined);
});

test("zero nights and Chinese numerals remain literal", () => {
  const h = harness();
  for (const label of ["确认1天0晚", "按一天零晚"]) {
    const repair = repairProductForExplicitInstruction(h.detail(), "", [label]);
    assert.equal((repair?.product.basicInfo as Record<string, unknown>).days, 1);
    assert.equal((repair?.product.basicInfo as Record<string, unknown>).nights, 0);
  }
  const repair = repairProductForExplicitInstruction(h.detail(), "改成1天0晚");
  assert.equal((repair?.product.basicInfo as Record<string, unknown>).nights, 0);
});

test("remote/basic-saved/running guards survive the new selected-answer route", () => {
  for (const flag of [{ productId: "123" }, { basicInfoSaved: true }, { automation: { id: "run", status: "running" as const, logs: [], phases: [] } }]) {
    const detail = { ...harness().detail(), ...flag };
    assert.equal(repairProductForExplicitInstruction(detail, "", ["解锁为5天4晚"]), undefined);
  }
});

test("failed preparation keeps the pending request and intent for retry", async () => {
  const h = harness();
  h.deps.prepareUserInstruction = async () => { throw new Error("persist failed"); };
  await assert.rejects(h.core.respond("product", { requestId: "request", answers: { "days-vs-itinerary": "unlock" } }), /persist failed/);
  assert.equal(h.snapshots.get("product")!.pendingInput!.id, "request");
  assert.equal(h.snapshots.get("product")!.run!.intentVersion, "old");
});

test("an explicit user-authored text answer also persists before continuation", async () => {
  const h = harness();
  h.request.questions = [{ id: "duration", label: "天数", kind: "text", required: true }];
  await h.core.respond("product", { requestId: "request", answers: { duration: "改成5天4晚" } });
  assert.equal(h.mutations(), 1);
  await h.core.idle("product");
});

test("a plain duration option is applied only for its duration question and clears that request after persistence", async () => {
  const h = harness();
  h.request.questions = [{
    id: "actual_days", label: "实际天数", kind: "single", required: true,
    options: [
      { id: "5d4n", label: "5天4晚（按您原始描述的行程）" },
      { id: "keep", label: "保留当前天数" },
    ],
  }];
  const result = await h.core.respond("product", { requestId: "request", answers: { actual_days: "5d4n" } });
  assert.equal(h.detail().product.basicInfo!.days, 5);
  assert.equal(h.detail().product.basicInfo!.nights, 4);
  assert.equal(h.mutations(), 1);
  assert.equal(result.pendingInput, undefined);
});

test("a final duration confirmation option is accepted only with its duration question", () => {
  const h = harness("坚持5天4晚（需要您确认解锁 lockedConstraints，我再重试）");
  const repair = repairProductForExplicitInstruction(
    h.detail(),
    "",
    ["坚持5天4晚（需要您确认解锁 lockedConstraints，我再重试）"],
    [{ id: "final_days", label: "最终天数", selectedLabel: "坚持5天4晚（需要您确认解锁 lockedConstraints，我再重试）" }],
  );
  assert.equal((repair?.product.basicInfo as Record<string, unknown>).days, 5);
  for (const selectedLabel of [
    "5天4晚（按6天5晚行程）",
    "坚持5天4晚（需要您确认解锁2天1晚或6天5晚）",
    "5天4晚（按原始描述吗）",
  ]) {
    assert.equal(repairProductForExplicitInstruction(
      h.detail(),
      "",
      [selectedLabel],
      [{ id: "final_days", label: "最终天数", selectedLabel }],
    ), undefined);
  }
});

test("text correction can accompany unrelated choices; conflicting durations refuse repair", () => {
  const detail = harness().detail();
  const repair = repairProductForExplicitInstruction(detail, "改成5天4晚", ["当地4钻酒店"]);
  assert.equal((repair?.product.basicInfo as Record<string, unknown>).days, 5);
  assert.ok(repairProductForExplicitInstruction(detail, "改成5天4晚", ["确认5天4晚"]));
  assert.equal(repairProductForExplicitInstruction(detail, "改成6天5晚", ["确认5天4晚"]), undefined);
  assert.equal(repairProductForExplicitInstruction(detail, "改成5天4晚或6天5晚"), undefined);
  assert.equal(repairProductForExplicitInstruction(detail, "不要再改成5天4晚"), undefined);
  assert.equal(repairProductForExplicitInstruction(detail, "不应该是5天4晚"), undefined);
  assert.equal(repairProductForExplicitInstruction(detail, "不要改成5天4晚", ["确认5天4晚"]), undefined);
  assert.equal(repairProductForExplicitInstruction(detail, "是否改成5天4晚？", ["确认5天4晚"]), undefined);
  assert.equal(repairProductForExplicitInstruction(detail, "", ["按五五天四晚"]), undefined);
  for (const instruction of ["改成5天4晚，酒店选A或B", "改成5天4晚，能继续吗？"]) {
    assert.equal((repairProductForExplicitInstruction(detail, instruction)?.product.basicInfo as Record<string, unknown>).days, 5);
  }
  assert.equal(repairProductForExplicitInstruction(detail, "是否改成5天4晚？"), undefined);
});
