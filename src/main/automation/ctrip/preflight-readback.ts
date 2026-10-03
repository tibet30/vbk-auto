import { toPlatformShortLocationName } from "../../../shared/location-short-name.js";
import { toWritableAdministrativeCityName } from "../../../shared/region-overrides.js";
import { placeholderDraftOnly, readActiveCoverFallback } from "../../../shared/cover-fallback.js";
import { formatProductFeaturesHtml, productFeaturesPlainText } from "../../domain/product/features-rich-text.js";
import { vbkSessionRequest } from "../../infrastructure/vbk-session-request.js";
import { assertVbkAckSuccess } from "../../infrastructure/vbk-response-error.js";
import { buildAdultTicketInclusionText } from "./terms.js";
import { enrichItineraryPoiMetadata } from "./itinerary-api/poi-metadata.js";
import { readBoundCoverImageIdsViaApi } from "./presentation/cover-bind.js";
import { buildRecommendationReasonsPlan } from "./presentation/recommendations.js";
import { selectedClauseItems } from "./traffic-line/clause-items.js";
import { postTrafficLineSoa, record, text, type JsonRecord, type TrafficLinePage } from "./traffic-line/client.js";

type ProductRecord = Record<string, any>;

function productRecord(value: unknown): ProductRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as ProductRecord : {};
}

function positiveInteger(value: unknown): number {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : 0;
}

function expectedCity(value: unknown, field: string): string {
  const city = toPlatformShortLocationName(String(value ?? "").trim());
  if (!city) throw new Error(`基本信息预检缺少 ${field}`);
  return city;
}

/** Validate the persisted city names and trip duration from getProductBaseInfo. */
export function verifyBasicInfoReadback(baseInfo: unknown, product: unknown, productId: string) {
  const remote = productRecord(baseInfo);
  const basicInfo = productRecord(productRecord(product).basicInfo);
  if (expectedCity(basicInfo.meetingCity, "basicInfo.meetingCity") !== expectedCity(basicInfo.destinationCity, "basicInfo.destinationCity")) {
    throw new Error("基本信息预检本地 meetingCity 与 destinationCity 不一致");
  }
  const meetingCity = toWritableAdministrativeCityName(expectedCity(basicInfo.meetingCity, "basicInfo.meetingCity"));
  const destinationCity = toWritableAdministrativeCityName(expectedCity(basicInfo.destinationCity, "basicInfo.destinationCity"));
  const days = positiveInteger(basicInfo.days);
  const nights = Number(basicInfo.nights);
  if (!days || !Number.isInteger(nights) || nights < 0) {
    throw new Error("基本信息预检的天数或晚数无效");
  }
  if (meetingCity !== destinationCity) {
    throw new Error("基本信息预检本地 meetingCity 与 destinationCity 不一致");
  }
  if (String(remote.productId) !== String(productId)) {
    throw new Error("基本信息预检回读产品 ID 不一致");
  }
  if (expectedCity(remote.masterDepartureCityName, "远端 masterDepartureCityName") !== meetingCity
    || expectedCity(remote.destinationCityName, "远端 destinationCityName") !== destinationCity
    || Number(remote.masterDepartureCityId) <= 0
    || Number(remote.destinationCityID) !== Number(remote.masterDepartureCityId)) {
    throw new Error("基本信息预检回读城市锚点不一致");
  }
  if (Number(remote.travelDays) !== days
    || Number(remote.maxTravelDays) !== days
    || Number(remote.travelNights) !== nights) {
    throw new Error(`基本信息预检回读行程天数不一致：${remote.travelDays}/${remote.maxTravelDays}/${remote.travelNights}`);
  }
  if (!String(remote.vendorProductCode ?? "").trim()) {
    throw new Error("基本信息预检缺少供应商产品编号");
  }
  return { cityId: Number(remote.masterDepartureCityId), meetingCity, destinationCity, days, nights };
}

/** Validate the remote product description and the unique, real Ctrip-library cover. */
export async function verifyPresentationReadback(
  page: TrafficLinePage,
  product: unknown,
  productId: string,
  info: unknown,
) {
  const productValue = productRecord(product);
  const presentation = productRecord(productValue.presentation);
  const cover = productRecord(presentation.cover);
  const fallback = readActiveCoverFallback(productValue);
  const isDraftFallback = Boolean(fallback);
  if (fallback && !placeholderDraftOnly(productValue)) {
    throw new Error("产品图文预检发现运营占位封面，但产品不是未提审、未上架草稿");
  }
  const coverImageId = fallback
    ? positiveInteger(fallback.remoteImageId)
    : cover.source === "ctripLibrary"
      ? positiveInteger(cover.imageId)
      : cover.source === "manualUpload"
        ? positiveInteger(cover.remoteImageId)
        : 0;
  if (!coverImageId) {
    throw new Error(fallback
      ? "产品图文预检的草稿占位封面尚未获得远端 imageId"
      : "产品图文预检缺少已绑定的真实封面 remote imageId");
  }
  const boundCoverIds = await readBoundCoverImageIdsViaApi(page, Number(productId));
  if (boundCoverIds.length !== 1 || boundCoverIds[0] !== coverImageId) {
    throw new Error(`产品图文预检封面绑定不一致：期望唯一 imageId=${coverImageId}，实际=${boundCoverIds.join(",") || "无"}`);
  }

  const remote = productRecord(info);
  const recommendations = buildRecommendationReasonsPlan(presentation.recommendations);
  const remoteRecommendations = Array.isArray(remote.pmRcmdItems) ? remote.pmRcmdItems : [];
  for (const expected of recommendations) {
    if (!remoteRecommendations.some((item) => text(productRecord(item).rcmdDesc) === expected.text)) {
      throw new Error(`产品图文预检推荐理由不一致：缺少「${expected.text}」`);
    }
  }
  const expectedFeatures = productFeaturesPlainText(formatProductFeaturesHtml(presentation.features));
  const actualFeatures = productFeaturesPlainText(productRecord(remote.productDesc).productDesc);
  const normalizeCopy = (value: string) => value.replace(/\s+/g, "").replace(/　/g, "");
  if (!expectedFeatures || !normalizeCopy(actualFeatures).includes(normalizeCopy(expectedFeatures))) {
    throw new Error("产品图文预检产品特色文案不一致");
  }
  return { coverImageId, recommendationCount: recommendations.length, featuresSaved: true, draftFallback: isDraftFallback };
}

function clauseText(items: JsonRecord[], clauseItemId: number, componentCode: string): string {
  const item = items.find((candidate) => Number(candidate.clauseItemId) === clauseItemId);
  if (!item) return "";
  const components = Array.isArray(item.elementDtos) ? item.elementDtos : [];
  const component = components.find((candidate: JsonRecord) => {
    const code = candidate.componentCode;
    if (typeof code !== "string" && typeof code !== "number") {
      throw new Error(`条款 ${clauseItemId} 的 componentCode 结构异常`);
    }
    return text(code) === componentCode;
  });
  if (!component) return "";
  if (typeof component.value !== "string" && typeof component.value !== "number") {
    throw new Error(`条款 ${clauseItemId} 的 ${componentCode} 值结构异常`);
  }
  return text(component.value);
}

/**
 * Mother products use the same 20046 clause-package read protocol as the save
 * path, but must retain isTra=F. The traffic-line reader intentionally uses
 * isTra=T and cannot be reused here.
 */
async function readMotherProductClausePackage(page: TrafficLinePage, central: JsonRecord): Promise<JsonRecord> {
  const additional = record(central.additionalInfoDto);
  const firstClassTypeIds = additional?.firstClassTypeIds;
  const filter = record(central.filterConditionDto);
  if (!Array.isArray(firstClassTypeIds) || !filter) {
    throw new Error("母产品条款包缺少读取上下文");
  }
  const body: JsonRecord = {
    ...central,
    clauseFilterConditionDto: filter,
    firstClassClauseTypeIds: firstClassTypeIds,
    additionalInfoDto: { ...additional, isTra: "F", isChildrenToNew: "T" },
  };
  delete body.filterConditionDto;
  const response = await vbkSessionRequest(page, {
    endpoint: "https://online.ctrip.com/restapi/soa2/20046/getClausePackage",
    body,
    browserRequestTimeoutMs: 15_000,
    evaluateTimeoutMs: 20_000,
    errorLabel: "读取母产品条款包",
    headers: {
      cookieorigin: "https://vbooking.ctrip.com",
      "x-tt-core": "1",
      "content-type": "text/plain;charset=UTF-8",
    },
  });
  return assertVbkAckSuccess(response.payload, "读取母产品条款包") as JsonRecord;
}

/** Read all four persisted clause packages and compare adult/child ticket text to the itinerary builder. */
export async function verifyTermsReadback(
  page: TrafficLinePage,
  product: unknown,
  productId: string,
  clauseTabs: readonly unknown[],
) {
  if (clauseTabs.length !== 4) throw new Error("条款预检回读缺少四个页签");
  const packages: Array<{ tabEnum: number; selectedCount: number }> = [];
  let firstTabItems: JsonRecord[] = [];
  for (const [index, payload] of clauseTabs.entries()) {
    const tabEnum = index + 1;
    const central = record(productRecord(payload).centralDataDto);
    if (!central || !record(central.additionalInfoDto)) {
      throw new Error(`条款预检回读页签 ${tabEnum} 缺少 centralDataDto`);
    }
    const clausePackage = await readMotherProductClausePackage(page, central);
    const selected = selectedClauseItems(clausePackage);
    packages.push({ tabEnum, selectedCount: selected.length });
    if (tabEnum === 1) firstTabItems = selected;
  }
  const itinerary = Array.isArray(productRecord(product).itinerary) ? productRecord(product).itinerary : [];
  const enrichedItinerary = itinerary.length
    ? await enrichItineraryPoiMetadata(page as never, itinerary)
    : [];
  const expectedTicketText = buildAdultTicketInclusionText(enrichedItinerary);
  const adultText = clauseText(firstTabItems, 13, "landticketremarks");
  const childText = clauseText(firstTabItems, 10087, "landticket2");
  if (adultText !== expectedTicketText || childText !== expectedTicketText) {
    throw new Error(`条款预检门票文本不一致：成人=${adultText || "无"}，儿童=${childText || "无"}，期望=${expectedTicketText || "无"}`);
  }
  return { tabs: packages, adultTicketInclusionText: expectedTicketText };
}

/** The SOA list protocol is shared so callers can obtain the four centralDataDto values once. */
export async function listProductClauseTabsForPreflight(page: TrafficLinePage, productId: string) {
  return Promise.all([1, 2, 3, 4].map((tabEnum) =>
    postTrafficLineSoa(page, "15638", "listProductClauses", { productId: String(productId), tabEnum }, `VBK 条款页签 ${tabEnum} 预检回读`)));
}
