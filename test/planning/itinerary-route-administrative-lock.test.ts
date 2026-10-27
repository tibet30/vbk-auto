import assert from "node:assert/strict";
import test from "node:test";
import { buildProductSnapshot } from "../../src/main/infrastructure/database/parts/product-draft.js";
import {
  classifyItineraryInputMode,
  explicitAlternativeGroups,
  itineraryInputContractError,
  rawAlternativeGroups,
} from "../../src/main/planning/itinerary-input-contract.js";
import { extractLockedConstraints } from "../../src/main/agent/prompt-helpers.js";
import { projectCompleteItinerary } from "../../src/main/planning/complete-itinerary-projection.js";
import { itineraryStructureError } from "../../src/main/planning/itinerary-structure.js";
import { normalisePlatformHotelProduct, platformHotelStayGroups } from "../../src/shared/platform-hotel-rules.js";
import type { ProductDetail } from "../../src/shared/contracts.js";

/** 真实卡死样本：万州 5 天 4 晚自由行（`e10dc37e`）的原始需求。 */
const WANZHOU_ROUTE = `DAY1：出发地-重庆万州-住万州
DAY2：龙虹国家地质公园-张飞庙-住云阳
DAY3：白帝城-三峡之巅-住奉节
DAY4：巫峡-船观神女峰-三峡龙脊-神女大扶梯-住巫山或者万州
DAY5：返程`;

function draft(userIdea = WANZHOU_ROUTE): ProductDetail {
  const product = buildProductSnapshot({ destination: "万州", days: 5, productForm: "freeTravel" });
  Object.assign(product.product.basicInfo!, {
    days: 5,
    nights: 4,
    meetingCity: "万州",
    destinationCity: "万州",
    destination: "万州",
    province: "重庆",
    subtitle: "万州三峡沿线5天4晚自由行",
    operationNotes: "按原路线安排，住宿使用平台自动匹配酒店。",
    userIdea,
  });
  Object.assign(product.product.operations!, { pickupCity: "万州", transport: "none" });
  product.product.itinerary = [];
  return product;
}

function projectedItinerary(product: ProductDetail): Array<Record<string, any>> {
  const output = projectCompleteItinerary(product);
  assert.ok(output, "完整逐日路线应能本地投影");
  return output.modules[0]!.value as Array<Record<string, any>>;
}

test("住A或者B 是住宿城市二选一，不锁成景点 OR 组", () => {
  assert.deepEqual(rawAlternativeGroups("DAY4：巫峡-住巫山或者万州"), []);
  // 真景点二选一仍必须锁定，过滤不能扩大。
  assert.deepEqual(rawAlternativeGroups("DAY2：日喀则博物馆或者非遗中心参观"), [
    { day: 2, names: ["日喀则博物馆", "非遗中心参观"] },
  ]);
  const product = draft();
  assert.deepEqual(explicitAlternativeGroups(product), []);
});

test("省份+城市复合名不锁成景点，真实景点缺失仍被拦住", () => {
  const product = draft();
  // 提取层仍保留原文（路线核对要用），合同层把它当行政地点豁免。
  const locked = extractLockedConstraints(product, []);
  assert.ok(locked.pois.includes("重庆万州"));
  assert.equal(classifyItineraryInputMode(locked, 5), "complete");
  const itinerary = projectedItinerary(product);
  assert.equal(itineraryInputContractError(product, itinerary), undefined);
  assert.equal(itineraryStructureError({ ...product.product, itinerary }), undefined);
  const missingSpot = structuredClone(itinerary);
  missingSpot[2]!.spots = (missingSpot[2]!.spots as any[]).filter((spot) => spot.name !== "白帝城");
  assert.match(itineraryInputContractError(product, missingSpot) ?? "", /白帝城/);
});

test("投影不为行政落脚/返程节点生成假 POI，并保留跨城住宿城市", () => {
  const product = draft();
  const itinerary = projectedItinerary(product);
  const names = itinerary.flatMap((day) => (day.spots as any[]).map((spot) => spot.name));
  assert.ok(!names.includes("重庆万州"));
  assert.ok(!names.includes("返程"));
  assert.deepEqual((itinerary[0]!.spots as any[]), []);
  assert.match(JSON.stringify(itinerary[0]!.activities), /重庆万州/);
  assert.equal(itinerary[4]!.hotel, "无");
  assert.equal(itinerary[3]!.hotelCity, "巫山");
  const normalised = normalisePlatformHotelProduct({ ...product.product, itinerary });
  assert.deepEqual(platformHotelStayGroups(normalised).map((group) => group.cityName),
    ["万州", "云阳", "奉节", "巫山"]);
});

test("已锁定的行政节点允许以自由活动/接送活动承载，城市+送站不算新增景点", () => {
  const product = draft();
  const itinerary = [
    { day: 1, spots: [{ name: "重庆万州", kind: "free" }], activities: [{ type: "transport", title: "接站", detail: "万州接站" }] },
    { day: 2, spots: [{ name: "龙虹国家地质公园" }, { name: "张飞庙" }] },
    { day: 3, spots: [{ name: "白帝城" }, { name: "三峡之巅" }] },
    { day: 4, spots: [{ name: "巫峡" }, { name: "船观神女峰" }, { name: "三峡龙脊" }, { name: "神女大扶梯" }] },
    { day: 5, spots: [{ name: "万州送站", kind: "other" }] },
  ];
  assert.equal(itineraryInputContractError(product, itinerary), undefined);
});
