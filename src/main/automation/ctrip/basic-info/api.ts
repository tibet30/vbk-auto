import type { ContactCardSelection } from "../../../../shared/contracts.js";
import { vbkSessionRequest, type VbkSessionRequestBrowser } from "../../../infrastructure/vbk-session-request.js";
import { listProviderContactCards } from "../../../infrastructure/butler-contacts.js";
import { resolveAdvanceBooking } from "../../schema/schema-functions.js";
import { normalizeVbkSubtitle } from "./core.js";

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
}

function record(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
}

function list(value: unknown): Json[] {
  return Array.isArray(value) ? value.filter((item): item is Json => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : [];
}

function ack(payload: unknown, label: string): Json {
  const root = record(payload);
  const status = record(root.ResponseStatus);
  const errors = list(status.Errors);
  const statusAck = String(status.Ack ?? "");
  if (statusAck !== "Success" || errors.length) {
    const detail = errors.map((item) => String(item.Message ?? item.Code ?? "")).filter(Boolean).join("、");
    throw new Error(`${label}失败（Ack=${statusAck || "缺失"}）${detail ? `：${detail}` : ""}`);
  }
  return root;
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

export async function getProductBaseInfoApi(page: VbkSessionRequestBrowser, productId: string): Promise<Json> {
  return post(page, "getProductBaseInfo", {
    productId,
    needAdvancedSettings: true,
    needBaseInfo: true,
    needBookingControls: true,
    needContractInfo: true,
    needMeta: true,
    needNameArea: true,
    need4135PackageInfo: true,
    needSaleControlInfo: true,
    needViewLink: true,
    needDistrictScenicSpots: true,
    needParentChildren: true,
  }, "VBK 基本信息回读");
}

async function getProductBaseInfoSaveModel(page: VbkSessionRequestBrowser, productId: string): Promise<Json> {
  return page.evaluate(async (id) => {
    const response = await fetch(`https://vbooking.ctrip.com/ivbk/vendor/baseInfoMerge?productId=${encodeURIComponent(id)}&from=vbk`, {
      method: "GET",
      credentials: "include",
      headers: { accept: "text/html,application/xhtml+xml,*/*;q=0.8" },
    });
    if (!response.ok) throw new Error(`VBK 基本信息保存模型读取失败：HTTP ${response.status}`);
    const html = await response.text();
    const match = html.match(/window\.__INITIAL_STATE__\s*=\s*(.*)/);
    if (!match) throw new Error("VBK 基本信息页面缺少 __INITIAL_STATE__");
    let state: any;
    try { state = JSON.parse(match[1]); } catch { throw new Error("VBK 基本信息保存模型 JSON 无效"); }
    const model = state?.productBaseInfo;
    if (!model || typeof model !== "object") throw new Error("VBK 基本信息页面缺少 productBaseInfo 保存模型");
    return {
      ...model,
      resourceFields: state?.resourceFields ?? {},
      localInfoDtos: state?.localInfoDtos ?? [],
    };
  }, productId);
}

async function resolveCity(page: VbkSessionRequestBrowser, cityName: string): Promise<Json> {
  const payload = await post(page, "suggestDepartureCity", { keyword: cityName }, "VBK 城市查询");
  const exact = list(payload.cities).filter((city) => String(city.cityName ?? "").trim() === cityName.trim());
  if (exact.length !== 1) throw new Error(`城市「${cityName}」无法唯一匹配：${exact.length} 个精确候选`);
  const city = exact[0];
  if (!Number.isInteger(Number(city.cityId)) || Number(city.cityId) <= 0) throw new Error(`城市「${cityName}」缺少合法 cityId`);
  return city;
}

function trimAdministrativeSuffix(value: unknown): string {
  return String(value ?? "").trim()
    .replace(/(维吾尔自治区|壮族自治区|回族自治区|特别行政区|自治区|省|市)$/u, "");
}

async function resolveProductLine(page: VbkSessionRequestBrowser, info: Json, cityId: number): Promise<Json> {
  const candidates = [...new Set([
    `${String(info.destinationCity ?? "").trim()}一地`,
    `${trimAdministrativeSuffix(info.province)}一地`,
  ].filter((value) => value !== "一地"))];
  const payload = await post(page, "getProductLinesByDestinationCityId", {
    destinationCityId: cityId,
  }, "VBK 产品线查询");
  for (const name of candidates) {
    const matches = list(payload.productLineDtos).filter((item) =>
      String(item.lineName ?? "").trim() === name);
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) throw new Error(`产品线「${name}」无法唯一匹配：${matches.length} 个候选`);
  }
  throw new Error(`产品线无法按城市/省份精确匹配：${candidates.join("、") || "无候选"}`);
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
): Promise<BasicInfoApiResult> {
  const [saveModel, remote] = await Promise.all([
    getProductBaseInfoSaveModel(page, productId),
    getProductBaseInfoApi(page, productId),
  ]);
  const sourceBase = record(remote.baseInfo);
  const sourceBooking = record(remote.bookingControl ?? remote.bookingControls);
  const agencyId = Number(sourceBooking.localInfoID ?? (Array.isArray(sourceBooking.localInfoIds) ? sourceBooking.localInfoIds[0] : 0));
  const agencies = list(saveModel.localInfoDtos);
  const agencyMatches = agencies.filter((agency) => Number(agency.localInfoID ?? agency.localInfoId ?? agency.id) === agencyId
    && String(agency.active ?? agency.isActive ?? "T") !== "F");
  if (!agencyId || agencyMatches.length !== 1) throw new Error(`VBK 地接社无法按已选 ID 精确匹配：${agencyMatches.length} 个候选`);
  const info = record(product.basicInfo);
  const meetingCity = String(info.meetingCity ?? "").trim();
  const destinationCity = String(info.destinationCity ?? "").trim();
  if (!meetingCity || destinationCity !== meetingCity) throw new Error("基本信息 API 要求集合城市与目的城市使用同一已锁定城市");
  const [city, phone, contact] = await Promise.all([
    resolveCity(page, meetingCity),
    resolvePhone(page, sourceBase, servicePhone),
    resolveContact(page, butler),
  ]);
  const productLine = await resolveProductLine(page, info, Number(city.cityId));
  const advance = resolveAdvanceBooking(product);
  if (!advance) throw new Error("提前预订配置非法");
  const scenicRules = desiredScenicRules(product, city, remote);
  if (!scenicRules.length) throw new Error("国家景区前置数据未返回合法景点 ID");
  const pattern = String(record(remote.meta).nameJoinRuleDto?.pattern ?? "").trim();
  const duration = `${Number(info.days)}日${Number(info.nights) > 0 ? `${Number(info.nights)}晚` : ""}`;
  const mainName = `${scenicRules.map((rule) => rule.pOIScenicSpotName).join("+")}${duration}${pattern}`;
  const baseInfo = {
    ...withoutKeys(sourceBase, ["destinationInfo", "extNumberId"]),
    productId: Number(productId),
    travelDays: Number(info.days),
    maxTravelDays: Number(info.days),
    travelNights: Number(info.nights),
    mainName,
    name: `${mainName}·${normalizeVbkSubtitle(info.subtitle, meetingCity)}`,
    subName: normalizeVbkSubtitle(info.subtitle, meetingCity),
    providerProductName: String(info.supplierProductName ?? "").trim(),
    vendorProductCode: String(info.supplierProductCode ?? "").trim(),
    productLineID: Number(productLine.lineId),
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
  const bookingControl = {
    ...mergeContact(sourceBooking, contact),
    advanceBookingDays: advance.days,
    advanceBookingTime: advance.time,
    personQuantity: {
      minPersonQuantity: Number(sourceBooking.minPersonQuantity ?? 1),
      maxPersonQuantity: Number(sourceBooking.maxPersonQuantity ?? 999),
    },
    localInfoIds: [agencyId],
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
    productLineId: Number(productLine.lineId),
    code: baseInfo.vendorProductCode,
    phone: String(phone.extNumberId ?? phone.extNumberID ?? phone.id),
    contactCardId: Number(butler.contactCardId),
  };
  if (Number(savedBase.masterDepartureCityId) !== expected.cityId
    || Number(savedBase.destinationCityID) !== expected.cityId
    || Number(savedBase.productLineID) !== expected.productLineId
    || String(savedBase.vendorProductCode ?? "") !== expected.code
    || String(savedBase.phone400 ?? "") !== expected.phone
    || Number(savedBooking.vendorBookingSeneschalContactId) !== expected.contactCardId) {
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
  };
}
