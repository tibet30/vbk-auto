import test from "node:test";
import assert from "node:assert/strict";
import { explicitTrafficLineCities, trafficLinePlanMatchesExplicitCities } from "../../src/shared/traffic-line-user-endpoints.js";
import { resolveTrafficLineDestination } from "../../src/main/automation/ctrip/traffic-line/endpoints.js";

const product = { basicInfo: { meetingCity: "西安", destinationCity: "西安",
  userIdea: "1-西安接---住太白山唐镇---泡温泉;\n2-五丈原---岐山---黄柏塬;\n6-汉中送飞机/送高铁" } };

test("用户明确西安接汉中送时核验异地进出，锁定产品城市不变", () => {
  assert.deepEqual(resolveTrafficLineDestination(product), { arrivalCity: "西安", departureCity: "汉中" });
  assert.equal(product.basicInfo.destinationCity, "西安");
  assert.equal(trafficLinePlanMatchesExplicitCities(product, { arrivalCity: "西安", departureCity: "西安" }), false);
  assert.equal(trafficLinePlanMatchesExplicitCities(product, { arrivalCity: "西安市", departureCity: "汉中市" }), true);
});

test("运营明确配置优先，途经和AI生成文字不推断交通端点", () => {
  assert.deepEqual(resolveTrafficLineDestination({ ...product, operations: { trafficLine: { departureCity: "成都市" } } }),
    { arrivalCity: "西安", departureCity: "成都" });
  assert.deepEqual(explicitTrafficLineCities({ basicInfo: { userIdea: "途经汉中，游览城固；入住汉中酒店" },
    itinerary: [{ title: "汉中送机" }] }), { arrivalCity: undefined, departureCity: undefined });
});

test("接送城市冲突时不选择首个，单端明确时另一端默认目的地", () => {
  assert.deepEqual(explicitTrafficLineCities({ basicInfo: { userIdea: "汉中送机；西安送机" } }),
    { arrivalCity: undefined, departureCity: undefined });
  assert.deepEqual(resolveTrafficLineDestination({ basicInfo: { destinationCity: "西安", userIdea: "汉中送高铁" } }),
    { arrivalCity: "西安", departureCity: "汉中" });
});

test("大交通抵达/离开短句识别异地端点，并使旧同城核验失效", () => {
  const fresh = { basicInfo: { destinationCity: "西宁", userIdea: "D6：瓜州 - 敦煌\n已确认的住宿要求：第6天敦煌结束不住宿。大交通抵达西宁、离开敦煌，同时生成飞机和火车子产品。" } };
  assert.deepEqual(explicitTrafficLineCities(fresh), { arrivalCity: "西宁", departureCity: "敦煌" });
  assert.deepEqual(resolveTrafficLineDestination(fresh), { arrivalCity: "西宁", departureCity: "敦煌" });
  assert.equal(trafficLinePlanMatchesExplicitCities(fresh, { arrivalCity: "西宁", departureCity: "西宁" }), false);
  assert.deepEqual(explicitTrafficLineCities({ basicInfo: { userIdea: "抵达青海湖后拍摄；离开俄博梁前拍照" } }), { arrivalCity: undefined, departureCity: undefined });
  assert.deepEqual(explicitTrafficLineCities({ basicInfo: { userIdea: "离开敦煌；离开西宁" } }), { arrivalCity: undefined, departureCity: undefined });
});

test("已核验但城市过期的大交通仍阻止准备完成", async () => {
  const { extraPreparationGaps } = await import("../../src/main/planning/preparation-checks.js");
  const draft = { basicInfo: { destinationCity: "西宁", userIdea: "大交通抵达西宁、离开敦煌" }, operations: { trafficLine: {
    enabled: true, variants: ["flightRoundTrip"], availability: { availableVariants: ["flightRoundTrip"], unavailableVariants: {},
      endpointPlan: { arrivalCity: "西宁", departureCity: "西宁", resolvedAt: "2026-10-09T00:00:00Z",
        flight: { arrival: { code: "XNN", name: "曹家堡机场" }, departure: { code: "DNH", name: "敦煌机场" } } } } } } };
  assert.ok(extraPreparationGaps(draft).some(gap => gap.label === "大交通端点可用性核验"));
  draft.operations.trafficLine.availability.endpointPlan.departureCity = "敦煌";
  assert.ok(!extraPreparationGaps(draft).some(gap => gap.label === "大交通端点可用性核验"));
});
