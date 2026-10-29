import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { approvedPlanVersion } from "../../src/main/application/product-approval-projection.js";
import { entryPhaseInputFingerprint } from "../../src/main/application/product-entry-phase-fingerprint.js";
import { productSchema } from "../../src/main/automation/schema/schema.js";
import { normaliseItinerary } from "../../src/main/data/product-normalize.js";
import { projectProductContext } from "../../src/main/planning/adapters/planning-prompt.js";
import {
  ensureItinerarySpotIds,
  isItinerarySpotId,
  stripItinerarySpotIds,
} from "../../src/shared/itinerary-spot-identity.js";

type Json = Record<string, any>;

/** 2 天 7 个景点、可通过 productSchema 的样例产品。 */
function fixture(): Json {
  return JSON.parse(fs.readFileSync(new URL("../../examples/taiyuan-private-2d1n.json", import.meta.url), "utf8"));
}

function withIds(product: Json): Json {
  const result = ensureItinerarySpotIds(product) as Json;
  const spots = (result.itinerary as Json[]).flatMap((day) => day.spots as Json[]);
  assert.ok(spots.length >= 4, "样例应有多个景点");
  assert.ok(spots.every((spot) => isItinerarySpotId(spot.spotId)), "每个景点都应已补上 spotId");
  assert.notEqual(result, product, "应当产生了新对象，否则下面的对比是空转");
  return result;
}

test("补 spotId 不改变审批指纹", () => {
  const product = fixture();
  assert.equal(
    approvedPlanVersion({ product } as never),
    approvedPlanVersion({ product: withIds(product) } as never),
  );
});

test("补 spotId 不改变各录入阶段指纹", () => {
  const product = fixture();
  const stamped = withIds(product);
  for (const phase of ["basic", "presentation", "itinerary", "vehicleResource", "terms", "trafficLine", "preflight"]) {
    assert.equal(
      entryPhaseInputFingerprint(stamped, phase),
      entryPhaseInputFingerprint(product, phase),
      `${phase} 阶段指纹不应受 spotId 影响`,
    );
  }
});

test("规范化保留合法 spotId，丢弃非法值", () => {
  const [day] = normaliseItinerary([{
    day: 1,
    title: "第一天",
    spots: [
      { name: "晋祠", spotId: "sp_0123456789ab" },
      { name: "平遥古城", spotId: "SP_BAD" },
      { name: "五台山", spotId: 12 },
    ],
    description: "测试",
    meals: "早餐；午餐；晚餐",
  }])!;
  const spots = day.spots as Json[];
  assert.equal(spots[0].spotId, "sp_0123456789ab");
  assert.equal("spotId" in spots[1], false);
  assert.equal("spotId" in spots[2], false);
});

test("模型上下文不含 spotId", () => {
  const stamped = withIds(fixture());
  assert.ok(JSON.stringify(stamped.itinerary).includes("spotId"));
  assert.equal(JSON.stringify(projectProductContext("itinerary", stamped)).includes("spotId"), false);
});

test("productSchema 接受带 spotId 的行程", () => {
  const stamped = withIds(fixture());
  const parsed = productSchema.safeParse(stamped);
  assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues));
  const first = (parsed.data!.itinerary[0].spots[0] as Json).spotId;
  assert.equal(first, (stamped.itinerary[0].spots[0] as Json).spotId);
});

test("stripItinerarySpotIds 返回副本且不修改入参", () => {
  const stamped = withIds(fixture());
  const before = JSON.stringify(stamped.itinerary);
  const stripped = stripItinerarySpotIds(stamped.itinerary);
  assert.equal(JSON.stringify(stamped.itinerary), before);
  assert.equal(JSON.stringify(stripped).includes("spotId"), false);
  assert.equal(stripItinerarySpotIds(["晋祠", null] as never)[0], "晋祠");
});
