import assert from "node:assert/strict";
import test from "node:test";
import { buildProductSnapshot } from "../../src/main/infrastructure/database/parts/product-draft.js";
import { excludedItineraryCopyConflicts } from "../../src/main/planning/itinerary-alternative-consistency.js";

test("普通人工删除也约束产品特色中的全名与简称，酒店名称不误报", () => {
  const product = buildProductSnapshot({ destination: "汉中", days: 1, productForm: "privateTour" });
  product.product.itinerary = [{ day: 1, title: "汉中休闲", spots: [{ name: "佛坪熊猫谷", kind: "attraction" }], description: "游览熊猫谷", hotel: "汉中中心酒店", meals: "自理" }];
  product.product.manualReview = { itinerarySpotRemovals: [{ day: 1, name: "汉中市古汉台博物馆", removedAt: "now" }] };
  product.product.presentation = { features: "<p>行程串联张良庙与古汉台等人文景点。</p>" };
  assert.deepEqual(excludedItineraryCopyConflicts(product), ["第1天「汉中市古汉台博物馆」"]);
  product.product.presentation = { features: "入住汉中中心广场古汉台店酒店。" };
  assert.deepEqual(excludedItineraryCopyConflicts(product), []);
});
