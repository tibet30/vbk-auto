import assert from "node:assert/strict";
import test from "node:test";
import { visibleVbkNavSections } from "../../src/renderer/app/helpers/constants.js";

function product(productForm: string, hotel = "", hotelSource?: string) {
  return {
    product: {
      sales: { productForm },
      operations: hotelSource ? { hotelSource } : {},
      itinerary: [{ hotel }],
    },
  } as any;
}

function resourcePhases(value: any) {
  return visibleVbkNavSections(value).find((section) => section.key === "resource")?.phaseNames ?? [];
}

test("资源配置只列出当前团态实际需要的阶段", () => {
  assert.deepEqual(resourcePhases(product("privateTour")), ["vehicleResource"]);
  assert.deepEqual(resourcePhases(product("privateTour", "当地酒店")), ["hotelResource", "vehicleResource"]);
  assert.deepEqual(resourcePhases(product("privateTour", "当地酒店", "nonPlatform")), ["vehicleResource"]);
  assert.deepEqual(resourcePhases(product("groupTour", "当地酒店")), ["hotelResource"]);
  assert.deepEqual(resourcePhases(product("semiSelfGuided", "当地酒店")), ["hotelResource"]);
  assert.deepEqual(resourcePhases(product("freeTravel", "当地酒店")), ["hotelResource"]);
});

test("无住宿的跟团游、半自助与自由行不显示资源配置", () => {
  for (const form of ["groupTour", "semiSelfGuided", "freeTravel"]) {
    assert.equal(
      visibleVbkNavSections(product(form)).some((section) => section.key === "resource"),
      false,
      `${form} 不应显示不适用的资源配置`,
    );
  }
});

test("已回读的平台酒店不被旧的 nonPlatform 标签隐藏，停用交通不显示待开始", () => {
  const p=product("groupTour", "汕头喜来登", "nonPlatform");
  p.product.operations.hotelResource={source:"ctrip"};
  p.product.operations.trafficLine={enabled:false, variants:[]};
  assert.deepEqual(resourcePhases(p), ["hotelResource"]);
  assert.equal(visibleVbkNavSections(p).some(section=>section.key==="trafficLine"), false);
});
