import { unlockedMenus } from "./product-menu-fixture.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { runProductPreflightApi } from "../../src/main/automation/ctrip/preflight-api.ts";

const productId = "78490993";
const groupId = 2206177;
const presentation = {
  cover: { source: "ctripLibrary", imageId: 99001 },
  recommendations: [
    { category: "服务保障", text: "专属行程服务全程跟随，接送与衔接清晰，陌生路况也可安心出行" },
    { category: "贴心赠送", text: "出行贴心安排，覆盖接送与餐饮赠送，体验更丰富，整体安排更省心" },
    { category: "精选酒店", text: "舒适住宿体验当地品质酒店，方便每日出行与休息，整体体验更舒适" },
  ],
  features: "<p>成都私家团</p>",
};

const product = {
  basicInfo: { meetingCity: "成都", destinationCity: "成都", days: 2, nights: 1 },
  presentation,
  sales: { productForm: "privateTour" },
  commercial: { packageName: "成都2天1晚私家团" },
  operations: { vehicleResource: { resourceGroupId: groupId, resourceGroupName: "成都用车组" } },
  itinerary: [{ day: 1, hotel: "无" }, { day: 2, hotel: "无" }],
};

function success(payload: Record<string, unknown>) {
  return { status: 200, payload: { ResponseStatus: { Ack: "Success" }, ...payload }, durationMs: 1, ctx: {} };
}

function vehicleSegment(id: string, bound: boolean) {
  return {
    segmentId: id,
    segmentBase: { stayNights: 0 },
    segmentResourceGroups: bound ? [{ resourceGroupId: groupId }] : [],
  };
}

function preflightPage(segments: { draft: unknown[]; formal: unknown[] }) {
  return { evaluate: async (_fn: unknown, request: any) => {
    const endpoint = String(request?.endpoint ?? "");
    if (endpoint.endsWith("/getSubMenu.json")) return success(unlockedMenus(productId));
    if (endpoint.endsWith("/getProductBaseInfo")) return success({ baseInfo: {
      productId: Number(productId), masterDepartureCityId: 28, masterDepartureCityName: "成都",
      destinationCityID: 28, destinationCityName: "成都", travelDays: 2, maxTravelDays: 2,
      travelNights: 1, vendorProductCode: `VBK-${productId}`,
    } });
    if (endpoint.endsWith("/getPackageList")) {
      return success({ itemList: [{ name: product.commercial.packageName, singleResourceId: 11 }] });
    }
    if (endpoint.endsWith("/getdescriptionInfo")) return success({ info: {
      pmRcmdItems: presentation.recommendations.map((item) => ({ rcmdDesc: item.text })),
      productDesc: { productDesc: presentation.features },
    } });
    if (endpoint.endsWith("/getProductTourInfoList")) return success({ tourInfos: [{ tourInfoId: 1001 }] });
    if (endpoint.endsWith("/getTourDailyDetail.json")) {
      return success({ tourInfo: { tourDailyDescriptions: [{}, {}] } });
    }
    if (endpoint.endsWith("/listProductClauses")) return success({
      centralDataDto: { additionalInfoDto: { firstClassTypeIds: [] }, filterConditionDto: { productId: 1 } },
    });
    if (endpoint.endsWith("/getClausePackage")) return success({ clauseTypeDtos: [] });
    if (endpoint.endsWith("/searchProductImage.json")) return success({
      productImages: [{ imageInfo: { imageId: 99001, accompanyTourInfo: { imageTypeId: 2 } } }],
    });
    if (endpoint.endsWith("/getSegments")) return success({
      draftProductSegments: { segments: segments.draft },
      productSegments: { segments: segments.formal },
    });
    throw new Error(`unexpected endpoint ${endpoint}`);
  } };
}

test("预检忽略错误草稿，并以正确正式段验证用车绑定", async () => {
  const result = await runProductPreflightApi(preflightPage({
    draft: [vehicleSegment("draft-full", false)],
    formal: [vehicleSegment("formal-full", true)],
  }), product, productId);

  assert.equal(result.resources.segmentCount, 1);
  assert.equal(result.resources.vehicle?.bound, true);
  assert.equal(result.resources.vehicle?.targetSegmentId, "formal-full");
});

test("预检不接受正确草稿掩盖空的正式资源段", async () => {
  await assert.rejects(
    () => runProductPreflightApi(preflightPage({
      draft: [vehicleSegment("draft-full", true)],
      formal: [],
    }), product, productId),
    /母产品资源预检未返回任何行程段/,
  );
});

test("所有模块回读正确但菜单锁定时，最终预检仍失败且不写携程", async () => {
  const base = preflightPage({ draft: [], formal: [vehicleSegment("formal-full", true)] });
  const requests: string[] = [];
  const page = { evaluate: async (fn: unknown, request: any) => {
    requests.push(request.endpoint);
    if (request.endpoint.endsWith("/getSubMenu.json")) {
      const menus = unlockedMenus(productId); menus.maxStep = -60;
      menus.menus[4].enabled = "F";
      return success(menus);
    }
    return base.evaluate(fn, request);
  } };
  await assert.rejects(() => runProductPreflightApi(page, product, productId), /VBK 菜单尚未解锁/);
  assert.equal(requests.some(endpoint => /save|create|submit|upload/i.test(endpoint)), false);
});

async function assertReviewBoundary(auditStatus: { key: "A" | "N"; value: string }, itineraryTourInfoId?: string) {
  const base = preflightPage({ draft: [], formal: [vehicleSegment("formal-full", true)] });
  const requests: string[] = [];
  const page = { evaluate: async (fn: unknown, request: any) => {
    const endpoint = String(request.endpoint);
    requests.push(endpoint);
    if (endpoint.endsWith("/getSubMenu.json")) {
      const menus = unlockedMenus(productId); menus.maxStep = -60;
      menus.menus.forEach((menu, index) => { menu.enabled = index < 4 ? "T" : "F"; });
      return success(menus);
    }
    if (endpoint.endsWith("/getProductBaseInfo")) return success({ baseInfo: {
      productId: Number(productId), masterDepartureCityId: 28, masterDepartureCityName: "成都",
      destinationCityID: 28, destinationCityName: "成都", travelDays: 2, maxTravelDays: 2,
      travelNights: 1, vendorProductCode: `VBK-${productId}`,
    }, isCruise: false });
    if (endpoint.endsWith("/getProductTourInfoList")) {
      return success({ tourInfos: [auditStatus.key === "N"
        ? { tourInfoId: 0, draftTourInfoId: 1001, auditStatus }
        : { tourInfoId: 1001, auditStatus },
      ] });
    }
    if (endpoint.endsWith("/inSwitch")) return success({ switched: true });
    return base.evaluate(fn, request);
  } };
  const result = await runProductPreflightApi(page, product, productId, { itineraryTourInfoId });
  assert.equal(result.menus.fullyUnlocked, false);
  assert.deepEqual(result.menus.lockedMenus, ["combomanage", "inventory", "travelOptionNew", "newResourceClause", "trafficLineEdit", "advancedSettings"]);
  assert.equal(result.menus.advancementRequiresReview, true);
  assert.equal(result.menus.draftSaved, true);
  assert.equal(result.menus.savedItineraryTourInfoId, itineraryTourInfoId ?? "1001");
  assert.deepEqual(result.menus.auditStatus, auditStatus);
  assert.equal(requests.some(endpoint => /save|create|submit|upload/i.test(endpoint)), false);
}

test("审核通过的官方行程审核边界保留只读预检", async () => {
  await assertReviewBoundary({ key: "A", value: "审核通过" });
});

test("未提交的官方行程审核边界保留只读预检", async () => {
  await assertReviewBoundary({ key: "N", value: "未提交" });
});

test("显式草稿行程 ID 与关联草稿一致时可通过审核边界", async () => {
  await assertReviewBoundary({ key: "N", value: "未提交" }, "1001");
});

test("显式草稿行程 ID 与关联草稿不一致时拒绝预检", async () => {
  await assert.rejects(
    () => assertReviewBoundary({ key: "N", value: "未提交" }, "2002"),
    /VBK 菜单尚未解锁/,
  );
});
