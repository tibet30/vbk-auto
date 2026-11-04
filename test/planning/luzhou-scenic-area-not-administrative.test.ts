import assert from "node:assert/strict";
import test from "node:test";
import { buildProductSnapshot } from "../../src/main/infrastructure/database/parts/product-draft.js";
import { projectCompleteItinerary } from "../../src/main/planning/complete-itinerary-projection.js";
import { itineraryInputContractError } from "../../src/main/planning/itinerary-input-contract.js";
import { isAdministrativeLocationName, toPlatformShortLocationName } from "../../src/shared/location-short-name.js";
import { isProductAdministrativeRouteName } from "../../src/shared/product-administrative-route-name.js";
import type { ProductDetail } from "../../src/shared/contracts.js";

/** 真实样本：泸州 2 天 1 晚自由行（`cd853daa`），「泸州老窖旅游区」被裁成「泸州老窖旅游」当行政地名丢掉。 */
const LUZHOU_ROUTE = "day1:泸州老窖旅游区-忠山公园-东门古城墙-珠子街-入住泸州\nday2：张坝桂圆林-尧坝古镇-返程";

function draft(): ProductDetail {
  const product = buildProductSnapshot({ destination: "泸州", days: 2, productForm: "freeTravel" });
  Object.assign(product.product.basicInfo!, {
    days: 2, nights: 1, meetingCity: "泸州", destinationCity: "泸州", destination: "泸州",
    province: "四川", userIdea: LUZHOU_ROUTE,
  });
  Object.assign(product.product.operations!, { pickupCity: "泸州" });
  product.product.itinerary = [];
  return product;
}

test("旅游区、度假区等景区后缀不按行政区「区」裁剪", () => {
  for (const name of ["泸州老窖旅游区", "张坝桂圆林旅游区", "汉中龙头山国际旅游度假区", "九寨沟风景名胜区", "卧龙自然保护区"]) {
    assert.equal(toPlatformShortLocationName(name), name);
    assert.equal(isAdministrativeLocationName(name), false, name);
  }
  // 真实行政区仍然裁剪。
  assert.equal(toPlatformShortLocationName("江阳区"), "江阳");
  assert.equal(isAdministrativeLocationName("江阳区"), true);
});

test("产品城市开头的景区名不是产品行政路线节点", () => {
  const { product } = draft();
  assert.equal(isProductAdministrativeRouteName(product, "泸州老窖旅游区"), false);
  assert.equal(isProductAdministrativeRouteName(product, "泸州"), true);
});

test("完整行程投影保留泸州老窖旅游区，合同校验要求保留它", () => {
  const product = draft();
  const output = projectCompleteItinerary(product);
  assert.ok(output, "完整逐日路线应能本地投影");
  const itinerary = output.modules[0]!.value as Array<Record<string, any>>;
  assert.deepEqual(itinerary[0]!.spots.map((spot: any) => spot.name), ["泸州老窖旅游区", "忠山公园", "东门古城墙", "珠子街"]);
  const dropped = structuredClone(itinerary);
  dropped[0]!.spots.shift();
  assert.match(itineraryInputContractError(product, dropped) ?? "", /泸州老窖旅游区/u);
});
