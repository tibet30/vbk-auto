import test from "node:test";
import assert from "node:assert/strict";
import { hotelAnswerInstruction } from "../../src/main/agent/hotel-answer-instruction.js";
import { applyPersistedHotelTierChoices, agentPatchOperations } from "../../src/main/agent/integration-patch.js";
import type { AgentEvent, ProductDetail } from "../../src/shared/contracts.js";
const request = (label = "第 3 天 留坝住宿 档位处理", id = "r") => ({ type: "input_request", content: "", data: { request: { id, questions: [{ id: "liuba_tier", label, kind: "single" }] } } } as unknown as AgentEvent);
const answer = (value: unknown = "同意下调为 当地4钻（系统可重试检索）", requestId = "r") => ({ type: "user", content: "用户回答", data: { requestId, resolvedAnswers: { liuba_tier: value } } } as unknown as AgentEvent);
const product = { operations: { hotelTier: "当地5钻酒店" }, itinerary: [{ day: 3, hotel: "留侯当地酒店", spots: [], hotelRequirement: { anchorName: "留侯", cityName: "留坝", maxDistanceKm: 5 } }] };
test("初始逐晚要求可设置对应日期等级，不能跨日期或覆盖已有等级", () => {
 const initial = { product: { basicInfo: { userIdea: "第1晚当地4钻，第3晚留侯3钻民宿" }, operations: { hotelTier: "当地5钻酒店" }, itinerary: [{ day: 3, hotel: "留侯民宿", spots: [], hotelRequirement: { anchorName: "留侯", cityName: "留坝" } }] }, messages: [] } as unknown as ProductDetail;
 assert.doesNotThrow(() => agentPatchOperations(initial, { itinerary: [{ day: 3, hotelRequirement: { diamond: 3, ratingType: "homestay" } }] }));
 assert.throws(() => agentPatchOperations(initial, { itinerary: [{ day: 3, hotelRequirement: { diamond: 4, ratingType: "diamond" } }] }), /评级变更/);
 const locked = structuredClone(initial) as any;
 locked.product.itinerary[0].hotelRequirement = { anchorName: "留侯", cityName: "留坝", diamond: 5, ratingType: "diamond" };
 assert.throws(() => agentPatchOperations(locked, { itinerary: [{ day: 3, hotelRequirement: { diamond: 3, ratingType: "homestay" } }] }), /评级变更/);
});
test("任意字段名通过请求和日期标签恢复用户选择，数字文本规范化且保留地点", () => {
 const instruction = hotelAnswerInstruction([request(), answer()]);
 const next = applyPersistedHotelTierChoices(product, instruction) as any;
 assert.equal(next.itinerary[0].hotelRequirement.diamond, 4);
 assert.equal(next.itinerary[0].hotelRequirement.ratingType, "diamond");
 const ops = agentPatchOperations({ product, messages: [] } as unknown as ProductDetail, { itinerary: [{ day: 3, hotelRequirement: { diamond: "4", maxDistanceKm: "5", ratingType: "diamond" } }] }, { hotelTierInstruction: instruction });
 const days = ops.find(op => op.path === "/itinerary")!.value as any[];
 assert.deepEqual(days[0].hotelRequirement, { anchorName: "留侯", cityName: "留坝", maxDistanceKm: 5, diamond: 4, ratingType: "diamond" });
});
test("无请求关联、非住宿问题、多个日期都不能授权", () => {
 for (const events of [[request(), answer(undefined, "wrong")], [request("第3天景点选择"), answer()], [request("第3天及第4天住宿"), answer()], [answer()]]) {
  assert.equal(applyPersistedHotelTierChoices(product, hotelAnswerInstruction(events)), product);
 }
});
test("最新拒绝、多选或无效回答覆盖旧许可", () => {
 for (const value of ["不同意降为4钻酒店", ["4钻酒店", "5钻酒店"], null]) {
  assert.equal(applyPersistedHotelTierChoices(product, hotelAnswerInstruction([request(), answer(), answer(value)])), product);
 }
});
test("同意降档不能扩大留侯锚点为整个留坝县或扩大距离", () => {
 const instruction = hotelAnswerInstruction([request(), answer()]);
 const detail = { product, messages: [] } as unknown as ProductDetail;
 assert.throws(() => agentPatchOperations(detail, { itinerary: [{ day: 3, hotelRequirement: { anchorName: "留坝", diamond: 4, ratingType: "diamond" } }] }, { hotelTierInstruction: instruction }), /住宿地点已锁定/);
 assert.throws(() => agentPatchOperations(detail, { itinerary: [{ day: 3, hotelRequirement: { maxDistanceKm: 50 } }] }, { hotelTierInstruction: instruction }), /距离范围/);
});
