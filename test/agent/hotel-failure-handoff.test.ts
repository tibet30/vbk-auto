import test from "node:test";
import assert from "node:assert/strict";
import { AgentToolRunner } from "../../src/main/agent/core-tools.js";
import { AgentSnapshotManager } from "../../src/main/agent/core-snapshot.js";
import { hotelAvailabilityQuestions } from "../../src/main/agent/core-preparation-hotel-input.js";
import type { AgentSnapshot, ProductDetail } from "../../src/shared/contracts.js";

const product = { product: { operations: { hotelTier: "当地5钻酒店" }, itinerary: [
  { day: 3, hotel: "俄博梁周边住宿", hotelRequirement: { anchorName: "俄博梁", cityName: "茫崖", maxDistanceKm: 5 }, spots: [] },
] } } as unknown as ProductDetail;

function harness(error: string, uncertainWrite = false) {
  let saved: AgentSnapshot = { localProductId: "p", run: { id: "r", status: "running", createdAt: "now", updatedAt: "now" }, events: [] };
  let sequence = 0;
  const now = () => new Date("2026-10-09T00:00:00Z");
  const id = () => `id-${++sequence}`;
  const manager = new AgentSnapshotManager({ getAgentSnapshot: () => saved, saveAgentSnapshot: value => { saved = structuredClone(value); } }, now, id);
  const runner = new AgentToolRunner({ tools: [{ name: "resolve_itinerary_hotels", description: "resolve", parameters: {},
    execute: async () => { throw Object.assign(new Error(error), { uncertainWrite }); } }],
    accountFor: async () => ({ accountKey: "a", productVersion: "v" }), preparationProduct: () => product,
    model: { complete: async input => {
      const { questions } = JSON.parse(input.messages.at(-1)!.content);
      return { content: JSON.stringify(Object.fromEntries(questions.map((question: { id: string; kind: string }) =>
        [question.id, question.kind === "single" ? "lower_hotel" : "保留俄博梁，重试同地点酒店检索"]))) };
    } },
  }, manager, now, id);
  const execute = async () => {
    const call = { id: id(), name: "resolve_itinerary_hotels", arguments: {} };
    manager.event(saved, "tool_call", call.name, { toolCallId: call.id, name: call.name, arguments: call.arguments });
    manager.save(saved);
    await runner.execute("p", call, { runId: "r" });
    return manager.load("p");
  };
  return { execute };
}

test("重复酒店列表查询失败由 AI 判断住宿策略，不等待运营填写", async () => {
  const { execute } = harness("第 3 天住宿（检索城市：茫崖，要求：当地5钻）未完成：携程酒店列表未返回可用候选（可能触发验证码或该日期无房）。");
  assert.equal((await execute()).run?.status, "running");
  const next = await execute();
  assert.equal(next.run?.status, "running");
  assert.equal(next.pendingInput, undefined);
  const automatic = next.events.find(event => event.data?.automaticProductInput === true);
  assert.match(JSON.stringify(automatic?.data?.questions), /第 3 天.*俄博梁.*不代表当地没有酒店/);
  assert.equal(next.events.some(event => /相同工具和参数连续失败两次/.test(event.content)), false);
  const request = next.events.find(event => event.type === "input_request");
  assert.equal(request, undefined);
  assert.ok(next.events.some(event => event.type === "tool_call" && event.data?.name === "ask_user"));
});

test("实际候选不符合条件时由 AI 选择一个降档策略并保存", async () => {
  const { execute } = harness("第 3 天住宿未完成：携程当前结果没有满足俄博梁附近5km内地点与评级类型要求的候选");
  await execute();
  const next = await execute();
  assert.equal(next.run?.status, "running");
  assert.equal(next.pendingInput, undefined);
  assert.deepEqual(next.events.find(event => event.data?.automaticProductInput === true)?.data?.answers, { hotel3: "lower_hotel" });
});

test("地标查询失败给出对应日次，网络异常仍不提供降档选项", () => {
  const questions = hotelAvailabilityQuestions(product, "第 3 天住宿未完成：携程未找到茫崖内可定位的酒店检索地标：俄博梁");
  assert.equal(questions[0]?.kind, "text");
  assert.equal(questions[0]?.options, undefined);
  assert.deepEqual(hotelAvailabilityQuestions(product, "第3天住宿请求失败 HTTP 503"), []);
});

test("其他重复失败的暂停保留实际原因", async () => {
  const { execute } = harness("酒店查询请求 HTTP 503");
  await execute();
  const next = await execute();
  assert.equal(next.run?.status, "paused");
  assert.match(next.events.at(-1)!.content, /最近原因：酒店查询请求 HTTP 503/);
});

test("外部写入状态不确定时不能转入住宿修改", async () => {
  const { execute } = harness("第 3 天住宿未完成：携程酒店列表未返回可用候选", true);
  const next = await execute();
  assert.ok(next.uncertainWrite);
  assert.equal(next.pendingInput, undefined);
});
