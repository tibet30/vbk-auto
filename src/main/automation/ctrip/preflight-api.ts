import { vbkSessionRequest } from "../../infrastructure/vbk-session-request.js";
import { getProductBaseInfoApi } from "./basic-info/api.js";
import { ensureHotelResourceApi } from "./hotel-resource-api.js";
import { fetchTourDailyDetail, fetchTourInfoId } from "./itinerary-api/steps.js";
import { datesBetween, localBusinessDate } from "./pricing-api.js";
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
  const payload = record(response.payload);
  const status = record(payload.ResponseStatus);
  const errors = list(status.Errors);
  if (String(status.Ack ?? "") !== "Success" || errors.length) {
    throw new Error(`${label}失败（Ack=${String(status.Ack ?? "缺失")}）`);
  }
  return payload;
}

function remoteDate(row: Json): string {
  return String(row.adultPrice?.date ?? row.singleResourcePriceDtos?.[0]?.date ?? row.base?.productDate ?? row.date ?? "");
}

/** 聚合所有已保存模块的远端 API 证据，不打开任何 VBK 编辑页。 */
export async function runProductPreflightApi(page: any, product: any, productId: string) {
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
    fetchTourInfoId(page, productId),
  ]);
  const baseInfo = record(base.baseInfo);
  if (String(baseInfo.productId) !== String(productId)) throw new Error("基本信息预检回读产品 ID 不一致");
  if (Number(baseInfo.masterDepartureCityId) <= 0
    || Number(baseInfo.destinationCityID) !== Number(baseInfo.masterDepartureCityId)) {
    throw new Error("基本信息预检回读城市锚点不一致");
  }
  if (!String(baseInfo.vendorProductCode ?? "").trim()) throw new Error("基本信息预检缺少供应商产品编号");

  const packageItem = list(packages.itemList)[0];
  if (!packageItem || String(packageItem.name ?? "") !== String(product.commercial.packageName ?? "")) {
    throw new Error("套餐预检回读名称不一致");
  }
  const info = record(description.info);
  if (list(info.pmRcmdItems).length < 3 || !String(record(info.productDesc).productDesc ?? "").trim()) {
    throw new Error("产品图文预检回读不完整");
  }
  if (!tour.tourInfoId) throw new Error("行程预检回读缺少 tourInfoId");
  const detail = await fetchTourDailyDetail(page, tour.tourInfoId);
  if (detail.descriptions.length !== product.itinerary.length) {
    throw new Error(`行程预检回读天数不一致：${detail.descriptions.length}/${product.itinerary.length}`);
  }

  const clauseTabs = await Promise.all([1, 2, 3, 4].map((tabEnum) =>
    post(page, "listProductClauses", { productId: String(productId), tabEnum }, `VBK 条款页签 ${tabEnum} 预检回读`)));
  if (clauseTabs.some((payload) => !record(payload.centralDataDto).additionalInfoDto)) {
    throw new Error("条款预检回读缺少 centralDataDto");
  }

  let pricingEvidence: Json | null = null;
  if (inventory && pricing) {
    if (!packageItem.singleResourceId || !packageItem.optionalResourceId) throw new Error("价格库存预检缺少套餐资源 ID");
    const today = localBusinessDate();
    const dates = datesBetween(inventory.startDate, inventory.endDate)
      .filter((date) => date >= today)
      .slice(0, 365);
    if (!dates.length) throw new Error("价格库存预检没有可售业务日");
    const snapshot = await post(page, "GetBatchOperateSchedule", {
      packageKey: { masterResourceId: packageItem.singleResourceId, servantResourceId: packageItem.optionalResourceId },
      productId: Number(productId) || productId,
      yearMonth: dates[0]?.slice(0, 7),
    }, "VBK 价格库存预检回读");
    const rows = list(snapshot.dates);
    if (!rows.some((row) => remoteDate(row) === dates[0])) throw new Error(`价格库存预检未读到首个业务日 ${dates[0]}`);
    pricingEvidence = { firstDate: dates[0], remoteRowCount: rows.length };
  }

  const segmentPayload = await getProductSegmentsApi(page, productId);
  const segments = segmentsFromPayload(segmentPayload);
  if (!segments.length) throw new Error("资源预检未返回任何行程段");
  const hotel = product.itinerary.some((day: any) => Boolean(day.hotel))
    ? await ensureHotelResourceApi(page, product, productId)
    : { skipped: "行程不含住宿", verified: true };
  let vehicle: Json | null = null;
  if (product.sales.productForm === "privateTour") {
    const groupId = Number(product.operations?.vehicleResource?.resourceGroupId);
    if (!groupId) throw new Error("私家团未配置现有用车资源组 ID");
    vehicle = await verifyVehicleResourceBinding(page, productId, groupId);
    if (!vehicle.bound) throw new Error(`用车资源预检仅绑定 ${vehicle.matchedCount}/${vehicle.segmentCount} 个行程段`);
  }
  return {
    productId: String(productId),
    verifiedWith: "remote-api-readback",
    basic: { cityId: Number(baseInfo.masterDepartureCityId), vendorProductCode: String(baseInfo.vendorProductCode) },
    presentation: { recommendationCount: list(info.pmRcmdItems).length },
    itinerary: { tourInfoId: String(tour.tourInfoId), days: detail.descriptions.length },
    package: { name: String(packageItem.name), resourceId: String(packageItem.singleResourceId) },
    pricingInventory: pricingEvidence,
    clauses: clauseTabs.map((_, index) => index + 1),
    resources: { segmentCount: segments.length, hotel, vehicle },
  };
}
