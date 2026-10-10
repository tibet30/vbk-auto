import test from "node:test";
import assert from "node:assert/strict";
import { AgentCore } from "../../src/main/agent/core.js";
import { PRODUCT_PREPARATION_INSTRUCTION } from "../../src/main/agent/preparation-run.js";
import { resolvedProductQuestions } from "../../src/main/agent/pending-question-reconciliation.js";
import type { AgentSnapshot, ProductDetail } from "../../src/shared/contracts.js";

const candidate = { hotelId: 42, hotelName: "冷湖酒店", diamond: 4, score: 4.4, distanceKm: 1,
  cityName: "茫崖", anchorName: "冷湖镇", anchorCityId: 696158, ratingType: "diamond" };
const product = { product: { operations: { hotelTier: "当地5钻酒店" }, itinerary: [
  { day: 3, hotel: "俄博梁住宿", spots: [], hotelRequirement: { anchorName: "俄博梁", cityName: "茫崖", maxDistanceKm: 5 } },
  { day: 4, hotel: "冷湖酒店", spots: [], hotelCandidates: [candidate], hotelRequirement: { anchorName: "冷湖镇", cityName: "茫崖", maxDistanceKm: 5, diamond: 4 } },
] } } as unknown as ProductDetail;

function harness(pause = "相同工具和参数连续失败两次，已暂停。请调整后再继续。", uncertain = false) {
  let saved: AgentSnapshot = { localProductId: "p", run: { id: "r", status: "paused", createdAt: "t", updatedAt: "t" }, events: [
    { id: "u", type: "user", runId: "r", content: PRODUCT_PREPARATION_INSTRUCTION, createdAt: "t" },
    { id: "c", type: "tool_call", runId: "r", content: "resolve_itinerary_hotels", createdAt: "t", data: { toolCallId: "c", name: "resolve_itinerary_hotels", arguments: {} } },
    { id: "f", type: "tool_result", runId: "r", content: "工具失败", createdAt: "t", data: { toolCallId: "c", error: "第 3 天住宿未完成：携程酒店列表未返回可用候选\n第 4 天住宿未完成：携程未找到茫崖内可定位的酒店检索地标：冷湖石油小镇" } },
    { id: "s", type: "status", runId: "r", content: pause, createdAt: "t", data: { status: "paused" } },
  ] };
  if (uncertain) saved.uncertainWrite = { toolCallId: "c", createdAt: "t", message: "unknown" };
  let calls = 0;
  const core = new AgentCore({ tools: [], model: { complete: async () => { calls++; return {}; } }, preparationProduct: () => product,
    accountFor: async () => ({ accountKey: "a", productVersion: "v" }),
  }, { getAgentSnapshot: () => saved, saveAgentSnapshot: next => { saved = structuredClone(next); } });
  return { core, calls: () => calls };
}

test("历史酒店重复失败转交 AI，已修复第4晚不再询问运营", async () => {
  const { core } = harness();
  const recovered = await core.get("p");
  assert.equal(recovered.run?.status, "running");
  assert.equal(recovered.pendingInput, undefined);
  const redirect = recovered.events.find(event => event.data?.recoveredHotelFailure === true);
  assert.match(redirect?.content ?? "", /hotel3/);
  assert.doesNotMatch(redirect?.content ?? "", /hotel4/);
  assert.equal(recovered.events.some(event => event.type === "input_request"), false);
  await core.idle("p");
  assert.equal((await core.get("p")).pendingInput, undefined);
});

test("人工暂停和写入不确定状态保持原状", async () => {
  for (const [pause, uncertain] of [["用户已暂停", false], ["相同工具和参数连续失败两次", true]] as const) {
    const { core, calls } = harness(pause, uncertain);
    const next = await core.get("p");
    assert.equal(next.run?.status, "paused");
    assert.equal(next.pendingInput, undefined);
    assert.equal(calls(), 0);
  }
});

test("当前真实候选回答住宿核验输入，但不代答降档单选或放过无效候选", () => {
  const question = { id: "hotel4", label: "第 4 天 冷湖镇住宿核验未完成，请补充准确住宿地点", kind: "text" as const };
  assert.equal(resolvedProductQuestions(product.product, [question]).length, 1);
  assert.deepEqual(resolvedProductQuestions(product.product, [{ ...question, kind: "single", options: [{ id: "lower", label: "降档" }] }]), []);
  const invalid = structuredClone(product.product) as any;
  invalid.itinerary[1].hotelCandidates[0].distanceKm = 100;
  assert.deepEqual(resolvedProductQuestions(invalid, [question]), []);
});
