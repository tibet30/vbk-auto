import test from "node:test";
import assert from "node:assert/strict";
import { hotelAvailabilityQuestions } from "../../src/main/agent/core-preparation-hotel-input.js";
import { hotelAnswerInstruction } from "../../src/main/agent/hotel-answer-instruction.js";
import { applyPersistedHotelTierChoices } from "../../src/main/agent/integration-patch.js";
import type { ProductDetail, AgentEvent } from "../../src/shared/contracts.js";
const product = { operations: { hotelTier: "当地5钻酒店" }, itinerary: [{ day: 3, hotel: "留侯酒店", hotelRequirement: { anchorName: "留侯", cityName: "留坝", maxDistanceKm: 5, diamond: 4, ratingType: "diamond" }, spots: [] }] };
test("真实候选不足时提供具体业务选择，网络异常不冒充无候选", () => {
 const detail = { product } as unknown as ProductDetail;
 const questions = hotelAvailabilityQuestions(detail, "第 3 天住宿（要求：当地4钻）未完成：携程当前结果没有满足留侯附近5km内地点与评级类型要求的候选");
 assert.equal(questions.length, 1);
 assert.equal(questions[0].id, "hotel3");
 const instruction = hotelAnswerInstruction([{ type: "input_request", data: { request: { id: "r", questions } } }, { type: "user", content: "", data: { requestId: "r", resolvedAnswers: { hotel3: questions[0].options![2].label } } }] as unknown as AgentEvent[]);
 const next = applyPersistedHotelTierChoices(product, instruction) as any;
 assert.equal(next.itinerary[0].hotelRequirement.ratingType, "homestay");
 assert.equal(next.itinerary[0].hotelRequirement.diamond, 3);
 assert.equal(next.itinerary[0].hotelRequirement.maxDistanceKm, 5);
 for (const result of ["第3天住宿请求失败 HTTP 503", "第3天住宿酒店列表为空，可能验证码", "网络连接失败"]) assert.deepEqual(hotelAvailabilityQuestions(detail, result), []);
});
