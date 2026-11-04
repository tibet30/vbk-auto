import assert from "node:assert/strict";
import test from "node:test";
import { buildProductSnapshot } from "../../src/main/infrastructure/database/parts/product-draft.js";
import { extractLockedConstraints } from "../../src/main/agent/prompt-helpers.js";
import { projectCompleteItinerary } from "../../src/main/planning/complete-itinerary-projection.js";
import { itineraryInputContractError } from "../../src/main/planning/itinerary-input-contract.js";
import type { ProductDetail } from "../../src/shared/contracts.js";

const SHAOSHAN = `D1：抵达黄花机场 → 韶山（毛泽东故居、铜像广场、韶峰），车程约 1h；宿韶山
D2：韶山 → 长沙市区（橘子洲、岳麓山）→ 送黄花机场`;

function draft(userIdea: string): ProductDetail {
  const product = buildProductSnapshot({ destination: "长沙", days: 2, productForm: "freeTravel" });
  Object.assign(product.product.basicInfo!, {
    days: 2, nights: 1, meetingCity: "长沙", destinationCity: "长沙", province: "湖南", userIdea,
  });
  product.product.itinerary = [];
  return product;
}

function projected(product: ProductDetail): Array<Record<string, any>> {
  const value = projectCompleteItinerary(product)?.modules[0]?.value;
  assert.ok(Array.isArray(value), "完整逐日路线应在模型前投影");
  return value as Array<Record<string, any>>;
}

test("括号内用顿号列出的子景点按顺序展开为独立景点", () => {
  const order = extractLockedConstraints(draft(SHAOSHAN), []).itineraryOrder;
  assert.deepEqual(order[0]!.spots, ["抵达黄花机场", "韶山", "毛泽东故居", "铜像广场", "韶峰"]);
  assert.deepEqual(order[1]!.spots.filter((name) => !/韶山|机场|长沙市区/.test(name)), ["橘子洲", "岳麓山"]);
});

test("车程时长是说明而不是景点", () => {
  const order = extractLockedConstraints(draft(SHAOSHAN), []).itineraryOrder;
  assert.ok(!order.flatMap((row) => row.spots).some((name) => /车程|1h/.test(name)));
});

test("活动、餐食、服务类括号不被展开成景点", () => {
  const order = extractLockedConstraints(draft(
    "D1：松花湖（滑雪、雪圈）→ 云顶市集（含门票、讲解）\nD2：长白山（早餐、午餐）",
  ), []).itineraryOrder;
  assert.deepEqual(order[0]!.spots, ["松花湖", "云顶市集"]);
  assert.deepEqual(order[1]!.spots, ["长白山"]);
});

test("韶山完整路线投影：景点齐全、不含车程、接送与住宿落到位", () => {
  const product = draft(SHAOSHAN);
  const itinerary = projected(product);
  const names = itinerary.map((day) => (day.spots as Array<{ name: string }>).map((spot) => spot.name));
  assert.ok(["毛泽东故居", "铜像广场", "韶峰"].every((name) => names[0]!.includes(name)), names[0]!.join(","));
  assert.ok(["橘子洲", "岳麓山"].every((name) => names[1]!.includes(name)), names[1]!.join(","));
  assert.ok(!names.flat().some((name) => /车程|1h/.test(name)));
  assert.match(String(itinerary[0]!.hotel), /韶山/);
  assert.equal(itinerary[0]!.hotelCity, "韶山");
  assert.ok(itinerary[1]!.activities?.some((item: any) => item.type === "transport" && /送黄花机场/.test(item.title)));
  assert.equal(itineraryInputContractError(product, itinerary), undefined);
});
