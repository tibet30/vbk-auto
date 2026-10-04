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
