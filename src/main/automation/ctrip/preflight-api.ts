import { hasItineraryHotelStay } from "../../../shared/itinerary-hotel.js";
import { productNeedsVehicleResource } from "../../../shared/product-form.js";
import { vbkSessionRequest } from "../../infrastructure/vbk-session-request.js";
import { assertVbkAckSuccess } from "../../infrastructure/vbk-response-error.js";
import { getProductBaseInfoApi } from "./basic-info/api.js";
import { verifyHotelResourceReadback } from "./hotel-resource-readback.js";
import { fetchTourDailyDetail, fetchTourInfoId } from "./itinerary-api/steps.js";
import { resolvePackageName } from "./package-api.js";
import {
  listProductClauseTabsForPreflight,
  verifyBasicInfoReadback,
  verifyPresentationReadback,
  verifyTermsReadback,
} from "./preflight-readback.js";
import { verifyPricingInventoryReadback } from "./pricing-readback.js";
import { getProductSegmentsApi, segmentsFromPayload, verifyVehicleResourceBinding } from "./vehicle-resource-api.js";

const SOA = "https://online.ctrip.com/restapi/soa2/15638";
const HEAD = { cid: "", ctok: "", cver: "1.0", lang: "01", sid: "8888", syscode: "09", auth: "", extension: [] };
type Json = Record<string, any>;

function record(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
}

function list(value: unknown): Json[] {
  return Array.isArray(value) ? value.filter((item): item is Json => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : [];
}

async function post(page: any, path: string, body: Json, label: string): Promise<Json> {
  const response = await vbkSessionRequest(page, {
    endpoint: `${SOA}/${path}`,
    browserRequestTimeoutMs: 15_000,
    evaluateTimeoutMs: 20_000,
    errorLabel: label,
    headers: { cookieorigin: "https://vbooking.ctrip.com" },
    body: { contentType: "json", head: HEAD, ...body },
  });
  return assertVbkAckSuccess(response.payload, label) as Json;
}

/** 聚合所有已保存模块的远端 API 证据，不打开任何 VBK 编辑页。 */
export async function runProductPreflightApi(
  page: any,
  product: any,
  productId: string,
  options: { itineraryTourInfoId?: string } = {},
) {
  if (!product.commercial) throw new Error("缺少 commercial 配置");
  const inventory = product.commercial.inventory;
  const pricing = product.commercial.pricing;
  if (inventory && pricing) {
    if (new Date(inventory.startDate) > new Date(inventory.endDate)) throw new Error("库存开始日期晚于结束日期");
    if (inventory.dailyQuota < pricing.minimumTravelers) throw new Error("每日库存小于最低成团人数");
  }

  const [base, packages, description, tour] = await Promise.all([
    getProductBaseInfoApi(page, productId),
    post(page, "getPackageList", { productId: Number(productId) || productId, priceInputType: 1 }, "VBK 套餐预检回读"),
    post(page, "getdescriptionInfo", { productId: Number(productId) || productId }, "VBK 图文预检回读"),
    options.itineraryTourInfoId
      ? Promise.resolve({ tourInfoId: options.itineraryTourInfoId })
      : fetchTourInfoId(page, productId),
  ]);
  const basic = verifyBasicInfoReadback(record(base.baseInfo), product, productId);

  const packageItem = list(packages.itemList)[0];
  if (!packageItem || String(packageItem.name ?? "") !== resolvePackageName(product)) {
    throw new Error("套餐预检回读名称不一致");
  }
  const presentation = await verifyPresentationReadback(page, product, productId, record(description.info));
  if (!tour.tourInfoId) throw new Error("行程预检回读缺少 tourInfoId");
  const detail = await fetchTourDailyDetail(page, tour.tourInfoId);
  if (detail.descriptions.length !== product.itinerary.length) {
    throw new Error(`行程预检回读天数不一致：${detail.descriptions.length}/${product.itinerary.length}`);
  }

  const clauseTabs = await listProductClauseTabsForPreflight(page, productId);
  const clauses = await verifyTermsReadback(page, product, productId, clauseTabs);

  const pricingEvidence = inventory && pricing ? await verifyPricingInventoryReadback(page, product, productId) : null;

  const hotelResource = record(record(product.operations).hotelResource);
  const hasPlannedHotel = product.itinerary.some((day: any) => hasItineraryHotelStay(day?.hotel));
  const needsVehicle = productNeedsVehicleResource(product);
  const segmentPayload = hasPlannedHotel || needsVehicle ? await getProductSegmentsApi(page, productId) : null;
  const segments = segmentPayload ? segmentsFromPayload(segmentPayload) : [];
  if ((hasPlannedHotel || needsVehicle) && !segments.length) throw new Error("母产品资源预检未返回任何行程段");
  // 老数据可能把已解析的携程候选标成 nonPlatform；只要行程明确含住宿，
  // 就必须以平台酒店资源回读为准，不能因为旧来源标签跳过核验。
  const hotel = hasPlannedHotel
    ? await verifyHotelResourceReadback(page, product, productId)
    : { skipped: hotelResource.source === "nonPlatform" ? "行程不含住宿" : "行程不含平台酒店资源", verified: true };
  let vehicle: Json | null = null;
  if (needsVehicle) {
    const groupId = Number(product.operations?.vehicleResource?.resourceGroupId);
    if (!groupId) throw new Error("产品未配置现有用车资源组 ID");
    vehicle = await verifyVehicleResourceBinding(page, productId, groupId);
    if (!vehicle.bound) throw new Error(`用车资源预检仅绑定 ${vehicle.matchedCount}/${vehicle.segmentCount} 个行程段`);
  }
  return {
    productId: String(productId),
    verifiedWith: "remote-api-readback",
    basic: { ...basic, vendorProductCode: String(record(base.baseInfo).vendorProductCode) },
    presentation,
    itinerary: { tourInfoId: String(tour.tourInfoId), days: detail.descriptions.length },
    package: { name: String(packageItem.name), resourceId: String(packageItem.singleResourceId) },
    pricingInventory: pricingEvidence,
    clauses,
    resources: { segmentCount: segments.length, hotel, vehicle },
  };
}
