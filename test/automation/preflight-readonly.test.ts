import assert from "node:assert/strict";
import test from "node:test";
import { buildFillMap } from "../../src/main/automation/automation.main/automation.main.run-one/fill-map.ts";
import { unlockedMenus } from "./product-menu-fixture.ts";

const productId = "78490995";
const product = {
  basicInfo: { meetingCity: "成都", destinationCity: "成都", days: 2, nights: 1 },
  presentation: { cover: { source: "ctripLibrary", imageId: 99001 }, recommendations: [
    { category: "服务保障", text: "专属行程服务全程跟随，接送与衔接清晰，陌生路况也可安心出行" },
    { category: "贴心赠送", text: "出行贴心安排，覆盖接送与餐饮赠送，体验更丰富，整体安排更省心" },
    { category: "精选酒店", text: "舒适住宿体验当地品质酒店，方便每日出行与休息，整体体验更舒适" },
  ], features: "<p>成都私家团</p>" },
  sales: { productForm: "freeTravel" }, commercial: { packageName: "成都2天1晚自由行" }, operations: { transport: "none" },
  itinerary: [{ day: 1, hotel: "无" }, { day: 2, hotel: "无" }],
};

function success(payload: Record<string, unknown>) {
  return { status: 200, payload: { ResponseStatus: { Ack: "Success" }, ...payload }, durationMs: 1, ctx: {} };
}

test("生产 fillMap 的 preflight 在审核推进边界保持只读", async () => {
  const requests: string[] = [];
  const page: any = {
    goto: async () => { throw new Error("preflight 不应导航"); },
    getByRole: () => { throw new Error("preflight 不应点击向导"); },
    evaluate: async (_fn: unknown, request: any) => {
      const endpoint = String(request.endpoint); requests.push(endpoint);
      if (endpoint.endsWith("/getSubMenu.json")) {
        const menus = unlockedMenus(productId); menus.maxStep = -60;
        menus.menus.forEach((menu, index) => { menu.enabled = index < 4 ? "T" : "F"; });
        return success(menus);
      }
      if (endpoint.endsWith("/getProductBaseInfo")) return success({ baseInfo: {
        productId: Number(productId), masterDepartureCityId: 28, masterDepartureCityName: "成都",
        destinationCityID: 28, destinationCityName: "成都", travelDays: 2, maxTravelDays: 2,
        travelNights: 1, vendorProductCode: `VBK-${productId}`,
      } });
      if (endpoint.endsWith("/getPackageList")) return success({ itemList: [{ name: product.commercial.packageName, singleResourceId: 11 }] });
      if (endpoint.endsWith("/getdescriptionInfo")) return success({ info: {
        pmRcmdItems: product.presentation.recommendations.map(item => ({ rcmdDesc: item.text })),
        productDesc: { productDesc: product.presentation.features },
      } });
      if (endpoint.endsWith("/getProductTourInfoList")) return success({ tourInfos: [{
        tourInfoId: 1001, auditStatus: { key: "A", value: "审核通过" },
      }] });
      if (endpoint.endsWith("/getTourDailyDetail.json")) return success({ tourInfo: { tourDailyDescriptions: [{}, {}] } });
      if (endpoint.endsWith("/listProductClauses")) return success({ centralDataDto: {
        additionalInfoDto: { firstClassTypeIds: [] }, filterConditionDto: { productId: 1 },
      }, unBookingContentDto: { holidayRuleDto: { lossValue: 0.8, travelAgencyLossValue: 0.8 } } });
      if (endpoint.endsWith("/getClausePackage")) return success({ clauseTypeDtos: [] });
      if (endpoint.endsWith("/searchProductImage.json")) return success({
        productImages: [{ imageInfo: { imageId: 99001, accompanyTourInfo: { imageTypeId: 2 } } }],
      });
      if (endpoint.endsWith("/inSwitch")) return success({ switched: true });
      throw new Error(`unexpected endpoint ${endpoint}`);
    },
  };
  const fills = buildFillMap({ ctx: { db: { getAgentSnapshot: () => undefined } } as any, localProductId: "local", page, productData: product as any,
    productId, run: {} as any, log: () => {}, persist: () => {} });
  const result: any = await fills.preflight();
  assert.equal(result.verifiedWith, "remote-api-readback");
  assert.equal(result.menus.fullyUnlocked, false);
  assert.ok(requests.some(endpoint => endpoint.endsWith("/getSubMenu.json")));
  assert.equal(requests.some(endpoint => /save|create|submit|upload/i.test(endpoint)), false);
});
