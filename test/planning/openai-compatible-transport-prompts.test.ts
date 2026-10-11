import test from "node:test";
import assert from "node:assert/strict";
import { OpenAIThreeStagePlanningAi } from "../../src/main/planning/adapters/three-stage-ai.js";
import { okToolCallResponse, startCapturingServer } from "./openai-compatible-transport-helpers.js";

test("ThreeStage 第一阶段通过结构化工具返回省市，并把上一轮准入失败反馈给 AI", async (t) => {
  const server = await startCapturingServer(t, (_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(okToolCallResponse("submit_standard_location", { province: "西藏", destinationCity: "拉萨" }));
  });
  const ai = new OpenAIThreeStagePlanningAi({ apiKey: "location-test-key", baseUrl: server.url, model: "location-model", provider: "test-provider" });
  const location = await ai.structureLocation({ destination: "西藏自治区", previousError: "第一阶段目的地准入失败：destinationCity 为空" });
  assert.deepEqual(location, { province: "西藏", destinationCity: "拉萨" });
  assert.equal(server.captured.length, 1);
  const request = server.captured[0].parsedBody;
  assert.equal(request.model, "location-model");
  assert.equal((request.tools as Array<{ function: { name: string } }>)[0].function.name, "submit_standard_location");
  assert.match(String((request.messages as Array<{ content: string }>)[0].content), /全球旅游产品/);
  assert.match(String((request.messages as Array<{ content: string }>)[0].content), /境外目的地/);
  assert.match(String((request.messages as Array<{ content: string }>)[1].content), /destinationCity 为空/);
});

test("ThreeStage 行程提示词携带完整 VBK 文案黑名单", async (t) => {
  const server = await startCapturingServer(t, (_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(okToolCallResponse("submit_verified_itinerary", { days: [{ day: 1, title: "城市人文漫游", description: "按片区依次游览", poiIds: [77593], meals: "早餐自理；午餐自理；晚餐自理", mealDescriptions: ["早餐自理", "午餐自理", "晚餐自理"] }] }));
  });
  const ai = new OpenAIThreeStagePlanningAi({ apiKey: "itinerary-test-key", baseUrl: server.url, model: "itinerary-model", provider: "test-provider" });
  await ai.composeVerifiedItinerary({ destination: "武汉", days: 1, candidates: [{ requestedName: "黄鹤楼", status: "resolved", poiId: 77593, poiName: "黄鹤楼", province: "湖北", city: "武汉" }], previousError: "上一轮命中祈福" });
  const messages = server.captured[0].parsedBody.messages as Array<{ content: string }>;
  assert.match(messages[0].content, /VBK 文案黑名单/);
  assert.match(messages[0].content, /祈福/);
  assert.match(messages[0].content, /第一（宣传排名用语）/);
  assert.match(messages[0].content, /区县和地址聚合/);
  assert.match(messages[0].content, /首日不写早餐/);
  assert.match(messages[0].content, /尾日不写晚餐/);
  assert.match(messages[0].content, /纯接送日或明确独立体验日允许 poiIds 为空/);
  assert.match(messages[0].content, /未命中也必须在原日期原位置保留为 attraction/);
  assert.match(messages[1].content, /上一轮命中祈福/);
});
