import type { ContactCardSelection } from "../../../../shared/contracts.js";
import { vbkSessionRequest, type VbkSessionRequestBrowser } from "../../../infrastructure/vbk-session-request.js";
import { assertVbkAckSuccess } from "../../../infrastructure/vbk-response-error.js";
import { listProviderContactCards } from "../../../infrastructure/butler-contacts.js";
import { resolveAdvanceBooking } from "../../schema/schema-functions.js";
import { toPlatformShortLocationName } from "../../../../shared/location-short-name.js";
import { getProductBaseInfoSaveModel } from "./save-model.js";
import { getProductBaseInfoApi } from "./read-base.js";
export { getProductBaseInfoApi } from "./read-base.js";
import { normalizeVbkSubtitle } from "./core.js";
import { privateTourSubtitle } from "../../../../shared/private-tour-copy.js";
import { privateTourTitleSpots } from "./private-tour.js";
import {
  productLineSaveField,
  resolveBasicInfoCityAnchor,
  selectProductLine,
} from "./product-line.js";

export {
  hasProductLineResolutionFailure,
  isProductLineResolutionError,
} from "./product-line.js";

const ENDPOINT = "https://online.ctrip.com/restapi/soa2/15638";
const HEAD = { cid: "", ctok: "", cver: "1.0", lang: "01", sid: "8888", syscode: "09", auth: "", extension: [] };

type Json = Record<string, any>;

export interface BasicInfoApiResult {
  savedWith: "basic-info-api";
  productId: string;
  cityId: number;
  phone400: string;
  contactCardId: number;
  scenicSpotCount: number;
  productLineSkipped: boolean;
  localTravelAgency: {
    id: number;
    name: string;
    selection: "existing" | "defaulted";
  };
}

export interface BasicInfoApiOptions {
  skipProductLine?: boolean;
}

function record(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
}

function list(value: unknown): Json[] {
  return Array.isArray(value) ? value.filter((item): item is Json => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : [];
}

function localTravelAgencyId(agency: Json): number {
  return Number(agency.localInfoID ?? agency.localInfoId ?? agency.id);
}

function isActiveLocalTravelAgency(agency: Json): boolean {
  return localTravelAgencyId(agency) > 0 && String(agency.active ?? agency.isActive ?? "T") !== "F";
}

function localTravelAgencyName(agency: Json): string {
  return String(agency.localInfoName ?? agency.localInfoNameCn ?? agency.name ?? "").trim();
}

export function resolveLocalTravelAgency(sourceBooking: Json, agencies: Json[]) {
  const selectedId = Number(sourceBooking.localInfoID
    ?? (Array.isArray(sourceBooking.localInfoIds) ? sourceBooking.localInfoIds[0] : 0));
  const activeAgencies = agencies.filter(isActiveLocalTravelAgency);
  if (!selectedId) {
    const fallback = activeAgencies[0];
    if (!fallback) throw new Error("VBK 地接社未选择且当前账号无可用候选");
    return { id: localTravelAgencyId(fallback), name: localTravelAgencyName(fallback), selection: "defaulted" as const };
  }
  const matches = activeAgencies.filter((agency) => localTravelAgencyId(agency) === selectedId);
  if (matches.length !== 1) throw new Error(`VBK 地接社无法按已选 ID 精确匹配：${matches.length} 个候选`);
  return { id: selectedId, name: localTravelAgencyName(matches[0]), selection: "existing" as const };
}

function ack(payload: unknown, label: string): Json {
  return assertVbkAckSuccess(payload, label) as Json;
}

async function post(page: VbkSessionRequestBrowser, path: string, body: Json, label: string): Promise<Json> {
  const response = await vbkSessionRequest(page, {
    endpoint: `${ENDPOINT}/${path}`,
    browserRequestTimeoutMs: 20_000,
    evaluateTimeoutMs: 25_000,
    errorLabel: label,
    headers: { cookieorigin: "https://vbooking.ctrip.com" },
    body: { contentType: "json", head: HEAD, ...body },
  });
  return ack(response.payload, label);
}



async function resolveCity(page: VbkSessionRequestBrowser, cityName: string): Promise<Json> {
  const payload = await post(page, "suggestDepartureCity", { keyword: cityName }, "VBK 城市查询");
  const city = selectAdministrativeCity(payload.cities, cityName);
  if (!Number.isInteger(Number(city.cityId)) || Number(city.cityId) <= 0) throw new Error(`城市「${cityName}」缺少合法 cityId`);
  return city;
}

/** 行政字段按同一短名精确匹配；只消费 suggestDepartureCity 的城市候选。 */
export function selectAdministrativeCity(cities: unknown, cityName: string): Json {
  const target = toPlatformShortLocationName(cityName);
  const exact = list(cities).filter((city) =>
    toPlatformShortLocationName(String(city.cityName ?? "")) === target);
  if (exact.length !== 1) throw new Error(`城市「${cityName}」无法唯一匹配：${exact.length} 个规范候选`);
  return exact[0];
}

async function resolveProductLine(page: VbkSessionRequestBrowser, info: Json, cityId: number, cityName: string): Promise<Json> {
  const payload = await post(page, "getProductLinesByDestinationCityId", {
    destinationCityId: cityId,
  }, "VBK 产品线查询");
  return selectProductLine(payload.productLineDtos, info, cityName);
}

function phoneText(item: Json): string {
  return String(item.extNumber ?? item.phone400 ?? item.number ?? item.extNumberName ?? "").trim();
}

async function resolvePhone(page: VbkSessionRequestBrowser, remoteBase: Json, expected: string): Promise<Json> {
  const payload = await post(page, "getExtNumberList", {
    vendorId: remoteBase.vendorId,
    productId: remoteBase.productId,
    regionId: remoteBase.destinationCountryId,
  }, "VBK 400 电话查询");
  const matches = list(payload.extNumberDtos ?? payload.extNumberList).filter((item) => phoneText(item) === expected.trim());
  if (matches.length !== 1) throw new Error(`400 电话「${expected}」无法唯一匹配：${matches.length} 个候选`);
  return matches[0];
}

async function resolveContact(page: VbkSessionRequestBrowser, selection: ContactCardSelection): Promise<Json> {
  const cards = await listProviderContactCards(page as any, selection.providerId, selection.displayName);
  const matches = cards.filter((card) => card.contactCardId === selection.contactCardId && card.displayName === selection.displayName);
  if (matches.length !== 1) throw new Error(`预订联系人「${selection.displayName}」无法按 ID 精确匹配`);
  return { ...record(matches[0].extra), contactCardId: matches[0].contactCardId, displayName: matches[0].displayName };
}

function mergeContact(booking: Json, contact: Json): Json {
  const id = Number(contact.contactCardId);
  return {
    ...booking,
    vendorBookingSeneschalContactId: id,
  };
}

function withoutKeys(source: Json, keys: string[]): Json {
  const result = { ...source };
  for (const key of keys) delete result[key];
  return result;
}

function desiredScenicRules(product: Json, city: Json, remote: Json): Json[] {
  const parentInfo = `${String(city.provinceName ?? city.cityName ?? "").trim()}/${String(city.countryName ?? "").trim()}`;
  const current = list(remote.nameAreas ?? remote.nameAreaRules);
  return list(product.itinerary)
    .flatMap((day) => list(day.spots))
    .map((spot) => ({ poiId: Number(spot.poiId), poiName: String(spot.name ?? "").trim() }))
    .filter((spot, index, all) => spot.poiId > 0 && spot.poiName
      && all.findIndex((other) => other.poiId === spot.poiId) === index)
    .slice(0, 3)
    .map((spot) => ({
      ...record(current.find((rule) => Number(rule.pOIScenicSpotID) === spot.poiId)),
      pOIScenicSpotID: String(spot.poiId), pOIScenicSpotName: spot.poiName, parentInfo,
    }));
}

export async function ensureBasicInfoApi(
  page: VbkSessionRequestBrowser,
  product: Json,
  productId: string,
  butler: ContactCardSelection,
  servicePhone: string,
  options: BasicInfoApiOptions = {},
): Promise<BasicInfoApiResult> {
  const remote = await getProductBaseInfoApi(page, productId);
  const saveModel = await getProductBaseInfoSaveModel(page, productId, remote);
  const sourceBase = record(remote.baseInfo);
  const sourceBooking = record(saveModel.bookingControls ?? saveModel.bookingControl);
  const agencies = list(saveModel.localInfoDtos);
  const localTravelAgency = resolveLocalTravelAgency(sourceBooking, agencies);
  const info = record(product.basicInfo);
  const meetingCity = resolveBasicInfoCityAnchor(product);
  const [city, phone, contact] = await Promise.all([
    resolveCity(page, meetingCity),
    resolvePhone(page, sourceBase, servicePhone),
    resolveContact(page, butler),
  ]);
  const productLine = options.skipProductLine
    ? null
    : await resolveProductLine(page, info, Number(city.cityId), String(city.cityName ?? meetingCity).trim());
  const advance = resolveAdvanceBooking(product);
  if (!advance) throw new Error("提前预订配置非法");
  const privateTour = record(product.sales).productForm === "privateTour";
  const titleSpots = privateTour ? await privateTourTitleSpots(page, product.itinerary ?? []) : undefined;
  const scenicRules = desiredScenicRules(titleSpots ? { itinerary: [{ spots: titleSpots }] } : product, city, remote);
  if (!scenicRules.length) throw new Error("国家景区前置数据未返回合法景点 ID");
  const pattern = String(record(remote.meta).nameJoinRuleDto?.pattern ?? "").trim();
  const duration = `${Number(info.days)}日${Number(info.nights) > 0 ? `${Number(info.nights)}晚` : ""}`;
  const mainName = `${scenicRules.map((rule) => rule.pOIScenicSpotName).join("+")}${duration}${pattern}`;
  const subtitle = privateTour
    ? privateTourSubtitle(info.subtitle, scenicRules.map(rule => String(rule.pOIScenicSpotName)))
    : normalizeVbkSubtitle(info.subtitle, meetingCity);
  const baseInfo = {
    ...withoutKeys(sourceBase, ["destinationInfo", "extNumberId", "productLineID"]),
    productId: Number(productId),
    travelDays: Number(info.days),
    maxTravelDays: Number(info.days),
    travelNights: Number(info.nights),
    mainName,
    name: `${mainName}·${subtitle}`,
    subName: subtitle,
    ...(privateTour ? { isAutoCalculateProductLevel: "F" } : {}),
    providerProductName: String(info.supplierProductName ?? "").trim(),
    vendorProductCode: String(info.supplierProductCode ?? "").trim(),
    ...productLineSaveField(productLine),
    operationNote: String(info.operationNotes ?? "").trim(),
    masterDepartureCityId: Number(city.cityId),
    masterDepartureCityName: city.cityName,
    masterDepartureCountryId: Number(city.countryId),
    masterDepartureCountryName: city.countryName,
    destinationCityID: Number(city.cityId),
    destinationCityName: city.cityName,
    destinationCountryId: Number(city.countryId),
    destinationCountryName: city.countryName,
    phone400: String(phone.extNumberId ?? phone.extNumberID ?? phone.id),
  };
  const childPrice = Number(product.commercial?.pricing?.child);
  // Zero-priced child inventory is not sellable on this platform. Keeping
  // forChild=T then makes later base-info saves fail with 20011227.
  const forChild = Number.isFinite(childPrice) && childPrice >= 0
    ? (childPrice > 0 ? "T" : "F") : String(sourceBooking.forChild ?? "F");
  const bookingControl = {
    ...mergeContact(sourceBooking, contact),
    forChild,
    advanceBookingDays: advance.days,
    advanceBookingTime: advance.time,
    personQuantity: {
      minPersonQuantity: Number(sourceBooking.minPersonQuantity ?? 1),
      maxPersonQuantity: Number(sourceBooking.maxPersonQuantity ?? 999),
    },
    localInfoIds: [localTravelAgency.id],
    childrenMinAge: Number(sourceBooking.childrenMinAge ?? 2),
    childrenMaxAge: Number(sourceBooking.childrenMaxAge ?? 12),
  };
  const meta = {
    ...record(remote.meta),
    saveType: 1,
    resizeTourDailyInfo: "F",
    clauseTabEnabled: "F",
  };
  const advancedSettings: Json = {
    ...withoutKeys(record(remote.advancedSettings), ["internationalTouristGroupTour"]),
    isVendorHasGoldGuide: String(record(record(remote.meta).switches).goldTourGuide ?? "F"),
  };
  const saveBody = {
    baseInfo,
    bookingControl,
    nameAreaRules: scenicRules,
    meta,
    advancedSettings,
    scenicSpots: remote.scenicSpots ?? [],
    resourceFields: saveModel.resourceFields ?? {},
    ...(saveModel.clause ? { clause: saveModel.clause } : {}),
  };
  await post(page, "saveProductBaseInfo", saveBody, "VBK 基本信息保存");
  const readback = await getProductBaseInfoApi(page, productId);
  const savedBase = record(readback.baseInfo);
  const savedBooking = record(readback.bookingControls ?? readback.bookingControl);
  const expected = {
    cityId: Number(city.cityId),
    productLineId: productLine ? Number(productLine.lineId) : null,
    code: baseInfo.vendorProductCode,
    phone: String(phone.extNumberId ?? phone.extNumberID ?? phone.id),
    contactCardId: Number(butler.contactCardId),
    localTravelAgencyId: localTravelAgency.id,
    complaintContactId: Number(sourceBooking.vendorComplainContactId),
    bookingContactId: Number(sourceBooking.vendorBookingContactId),
    emergencyContactId: Number(sourceBooking.vendorBookingEmergencyContactId),
    forChild,
  };
  const savedLocalTravelAgencyId = Number(savedBooking.localInfoID
    ?? (Array.isArray(savedBooking.localInfoIds) ? savedBooking.localInfoIds[0] : 0));
  if (Number(savedBase.masterDepartureCityId) !== expected.cityId
    || Number(savedBase.destinationCityID) !== expected.cityId
    || (expected.productLineId !== null && Number(savedBase.productLineID) !== expected.productLineId)
    || String(savedBase.vendorProductCode ?? "") !== expected.code
    || String(savedBase.phone400 ?? "") !== expected.phone
    || (privateTour && (savedBase.isAutoCalculateProductLevel !== "F" || savedBase.subName !== subtitle))
    || Number(savedBooking.vendorBookingSeneschalContactId) !== expected.contactCardId
    || Number(savedBooking.vendorComplainContactId) !== expected.complaintContactId
    || Number(savedBooking.vendorBookingContactId) !== expected.bookingContactId
    || Number(savedBooking.vendorBookingEmergencyContactId) !== expected.emergencyContactId
    || String(savedBooking.forChild) !== expected.forChild
    || savedLocalTravelAgencyId !== expected.localTravelAgencyId) {
    throw new Error("VBK 基本信息保存后远端回读不一致");
  }
  const savedScenicIds = new Set(list(readback.nameAreas).map((rule) => Number(rule.pOIScenicSpotID)));
  if (scenicRules.some((rule) => !savedScenicIds.has(Number(rule.pOIScenicSpotID)))) {
    throw new Error("VBK 国家景区保存后远端回读不一致");
  }
  return {
    savedWith: "basic-info-api",
    productId,
    cityId: expected.cityId,
    phone400: servicePhone.trim(),
    contactCardId: expected.contactCardId,
    scenicSpotCount: scenicRules.length,
    productLineSkipped: productLine === null,
    localTravelAgency,
  };
}
