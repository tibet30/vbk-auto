import assert from "node:assert/strict";
import test from "node:test";
import { buildProductSnapshot } from "../../src/main/infrastructure/database/parts/product-draft.js";
import { projectCompleteItinerary } from "../../src/main/planning/complete-itinerary-projection.js";
import { isProductAdministrativeRouteName } from "../../src/shared/product-administrative-route-name.js";
import type { ProductDetail } from "../../src/shared/contracts.js";

/** 真实样本：长沙 2 天 1 晚自由行（`2ec8e6c9`），「长沙市区」被当成景点要求绑定 POI。 */
const CHANGSHA_ROUTE = `D1：抵达黄花机场 → 韶山（毛泽东故居、铜像广场、韶峰），车程约 1h；宿韶山
D2：韶山 → 长沙市区（橘子洲、岳麓山）→ 送黄花机场`;

function draft(): ProductDetail {
  const product = buildProductSnapshot({ destination: "长沙", days: 2, productForm: "freeTravel" });
  Object.assign(product.product.basicInfo!, {
    days: 2, nights: 1, meetingCity: "长沙", destinationCity: "长沙", destination: "长沙",
    province: "湖南", userIdea: CHANGSHA_ROUTE,
  });
  Object.assign(product.product.operations!, { pickupCity: "长沙", transport: "none" });
  product.product.itinerary = [];
  return product;
}

test("产品所在城市的「市区/城区」是行政落脚点，不是景点", () => {
  const { product } = draft();
  assert.equal(isProductAdministrativeRouteName(product, "长沙市区"), true);
  assert.equal(isProductAdministrativeRouteName(product, "长沙城区"), true);
  assert.equal(isProductAdministrativeRouteName(product, "长沙"), true);
  // 其他城市的市区、以及真实景点不能被误降级。
  assert.equal(isProductAdministrativeRouteName(product, "湘潭市区"), false);
  assert.equal(isProductAdministrativeRouteName(product, "橘子洲"), false);
  assert.equal(isProductAdministrativeRouteName(product, "长沙市区博物馆"), false);
});

test("完整行程投影不把「长沙市区」写成景点，真实景点与顺序保持", () => {
  const output = projectCompleteItinerary(draft());
  assert.ok(output, "完整逐日路线应能本地投影");
  const itinerary = output.modules[0]!.value as Array<Record<string, any>>;
  const names = (day: number) => (itinerary[day - 1]!.spots as any[]).map((spot) => spot.name);
  assert.deepEqual(names(1), ["韶山", "毛泽东故居", "铜像广场", "韶峰"].filter((n) => names(1).includes(n)));
  assert.ok(!names(2).includes("长沙市区"), `第 2 天景点不应含长沙市区：${names(2).join("、")}`);
  assert.deepEqual(names(2).filter((n) => ["橘子洲", "岳麓山"].includes(n)), ["橘子洲", "岳麓山"]);
});

test("行程契约不要求保留「长沙市区」，真实景点缺失仍被拦住", async () => {
  const { itineraryInputContractError } = await import("../../src/main/planning/itinerary-input-contract.js");
  const product = draft();
  const itinerary = (projectCompleteItinerary(product)!.modules[0]!.value) as Array<Record<string, any>>;
  assert.equal(itineraryInputContractError(product, itinerary), undefined);
  const missing = structuredClone(itinerary);
  missing[1]!.spots = (missing[1]!.spots as any[]).filter((spot) => spot.name !== "岳麓山");
  assert.match(itineraryInputContractError(product, missing) ?? "", /岳麓山/);
});
