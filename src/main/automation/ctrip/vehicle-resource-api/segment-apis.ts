/**
 * vehicle-resource-api/segment-apis：15638 系列接口的核心封装。
 *   - getProductSegmentsApi：拉取 resources 草稿 + 正式段；
 *   - saveProductSegmentApi：保存一个完整行程段；
 *   - resolveResourceSegmentCityApi：精确匹配住宿城市（unique cityName），查无时按行政父级回退；
 *   - buildLodgingResourceSegment：以平台末尾空段为模板新建住宿段；
 *   - submitResourceSegmentsApi：提交资源配置草稿（不等于产品审核）；
 *   - futureSchedule：submitSegments 要求的日期数组（90 天后 + offset）。
 */

import { vbkSessionRequest } from "../../../infrastructure/vbk-session-request.js";
import { assertVbkAckSuccess } from "../../../infrastructure/vbk-response-error.js";
import type { ResourceCity, Segment } from "./types.js";
import { VBK_RESOURCE_HEAD } from "./types.js";
import { selectAdministrativeCity, type AdministrativeCityContext } from "../basic-info/administrative-city.js";
import { toPlatformShortLocationName } from "../../../../shared/location-short-name.js";
import { toVbkCityName } from "../../../../shared/region-overrides.js";
import { resolveAdministrativeParentCity } from "./administrative-parent-city.js";

export async function getProductSegmentsApi(page: any, productId: string) {
  const response = await vbkSessionRequest(page, {
    endpoint: "https://online.ctrip.com/restapi/soa2/15638/getSegments",
    browserRequestTimeoutMs: 12_000,
    evaluateTimeoutMs: 15_000,
    errorLabel: "VBK 资源配置查询",
    body: { contentType: "json", head: VBK_RESOURCE_HEAD, productId: Number(productId) || productId },
  });
  return assertVbkAckSuccess(response.payload, "VBK 资源配置查询");
}

export function assertVbkResourceResponse(payload: any, label: string) {
  assertVbkAckSuccess(payload, label);
}

/** 按资源编辑器的 /15638/saveSegment 协议保存完整行程段。 */
export async function saveProductSegmentApi(page: any, segment: Segment, errorLabel = "VBK 资源行程段保存") {
  const response = await vbkSessionRequest(page, {
    endpoint: "https://online.ctrip.com/restapi/soa2/15638/saveSegment",
    browserRequestTimeoutMs: 12_000,
    evaluateTimeoutMs: 15_000,
    errorLabel,
    body: { contentType: "json", head: VBK_RESOURCE_HEAD, segment },
  });
  assertVbkResourceResponse(response.payload, errorLabel);
}

/**
 * 资源编辑器的城市选择框同样使用 suggestDepartureCity。只接受唯一的精确城市，
 * 防止同名地级市或区县被误写到住宿行程段。
 */
export async function resolveResourceSegmentCityApi(page: any, cityName: string, context: AdministrativeCityContext = {}): Promise<ResourceCity> {
  // 「万州」等直辖市下辖区县不在 VBK 城市列表中，只能按其可写城市「重庆」写入。
  const expected = toVbkCityName(cityName.trim());
  if (!expected) throw new Error("住宿资源行程段缺少城市名称");
  const query = async (keyword: string) => {
    const response = await vbkSessionRequest(page, {
      endpoint: "https://online.ctrip.com/restapi/soa2/15638/suggestDepartureCity",
      browserRequestTimeoutMs: 12_000,
      evaluateTimeoutMs: 15_000,
      errorLabel: "VBK 住宿城市查询",
      headers: { cookieorigin: "https://vbooking.ctrip.com" },
      body: { contentType: "json", head: VBK_RESOURCE_HEAD, keyword },
    });
    assertVbkResourceResponse(response.payload, "VBK 住宿城市查询");
    // 平台查无结果时直接省略 cities 字段（实测「川主寺」「九寨沟沟口」），按空列表处理。
    const cities = (response.payload as any)?.cities;
    return (Array.isArray(cities) ? cities : []) as ResourceCity[];
  };
  let cities = await query(expected);
  // 单字县名的短名（眉、洋等）不能命中平台建议接口。仅补查询完整县名，
  // 仍由同一行政短名及国家/省份门禁选出唯一结果，不借用邻近城市。
  if (/^\p{Script=Han}$/u.test(expected) && (context.countryName === "中国" || context.province)
    && !cities.some(city => toPlatformShortLocationName(city.cityName) === expected)) {
    cities = await query(`${expected}县`);
  }
  let target = expected;
  let regional = context;
  if (!cities.length) {
    // 乡镇、景区门户不在平台城市表里：按行政父链取唯一的所属县市再查（川主寺 → 松潘）。
    const parent = await resolveAdministrativeParentCity(page, expected, context.province);
    if (!parent) throw new Error(`VBK 城市列表没有「${expected}」，行政区父级也无法唯一确认所属县市；请在行程规划中把当晚住宿城市改为所属县市`);
    target = parent.cityName;
    regional = { ...context, province: context.province ?? parent.provinceName };
    cities = await query(target);
    if (!cities.length) throw new Error(`住宿地「${expected}」的所属县市「${target}」（经${parent.via}）不在 VBK 城市列表中`);
  }
  const city = selectCityOrExplain(cities, target, regional);
  if (!Number.isInteger(Number(city.cityId)) || Number(city.cityId) <= 0) throw new Error(`住宿城市「${target}」缺少合法 cityId`);
  return structuredClone(city);
}

/**
 * 跨省住宿地只是被省份筛掉时，补一句运营能直接照做的处置：
 * 平台唯一候选在别的省，说明当晚住宿注记没被解析成「显式住宿城市」，
 * 只报「0 个候选」会让运营以为是平台缺城市。
 */
function selectCityOrExplain(cities: ResourceCity[], target: string, regional: AdministrativeCityContext): ResourceCity {
  try {
    return selectAdministrativeCity(cities, target, regional);
  } catch (error) {
    const nationwide = cities.filter((city) => toPlatformShortLocationName(city.cityName) === target);
    const only = nationwide.length === 1 ? nationwide[0] : undefined;
    if (!regional.province || !only?.provinceName) throw error;
    throw new Error(`${(error as Error).message}该城市平台唯一（${only.countryName || "中国"}/${only.provinceName}），`
      + `但不在当前要求的「${regional.province}」；若当晚确实跨省住在「${target}」，请在原路线当天写明「宿${target}」。`);
  }
}

/**
 * 以平台末尾空段为模板，在其前插入一个住宿段。新段绝不继承套餐、用车或酒店，
 * 并把停留范围与住宿晚数锁为同一个值，满足资源配置页的单值行程段语义。
 */
export function buildLodgingResourceSegment(args: {
  terminalTemplate: Segment;
  segmentNumber: number;
  departureCity: ResourceCity;
  destinationCity: ResourceCity;
  nights: number;
}): Segment {
  const nights = Number(args.nights);
  if (!Number.isInteger(nights) || nights <= 0) throw new Error(`住宿晚数无效：${String(args.nights)}`);
  const draft = structuredClone(args.terminalTemplate);
  return {
    ...draft,
    // saveSegment 的服务端会直接解包并读取 segmentId。新段必须明确传 0，
    // 空值会在服务端 Long.longValue() 处抛出空指针，无法触发新增逻辑。
    segmentId: 0,
    segmentResourceGroups: [],
    hotel: { segmentRooms: [] },
    segmentBase: {
      ...(draft.segmentBase ?? {}),
      segmentNumber: Number(args.segmentNumber),
      departureCity: structuredClone(args.departureCity),
      destinationCity: structuredClone(args.destinationCity),
      stayNights: nights,
      minStayNights: nights,
      maxStayNights: nights,
      deleteable: true,
    },
  };
}

/**
 * 提交资源配置草稿，使 saveSegment 的段内变更成为可跨页面保留的资源配置。
 * 这不是产品"提交审核"；审核仍只能由用户在 VBK 产品页手动发起。
 */
export async function submitResourceSegmentsApi(page: any, productId: string) {
  const response = await vbkSessionRequest(page, {
    endpoint: "https://online.ctrip.com/restapi/soa2/15638/submitSegments",
    browserRequestTimeoutMs: 12_000,
    evaluateTimeoutMs: 15_000,
    errorLabel: "VBK 资源配置提交",
    body: {
      contentType: "json",
      head: VBK_RESOURCE_HEAD,
      productId: Number(productId) || productId,
      // Tour Helper 的 submitSegments 协议要求 schedule 为日期数组，而不是周排期字符串。
      schedule: futureSchedule(),
      adultCount: 2,
      childCount: 0,
      audit: { saveStep: 2 },
    },
  });
  assertVbkResourceResponse(response.payload, "VBK 资源配置提交");
}

export function futureSchedule() {
  const today = new Date();
  return [1, 8, 15].map((offset) => {
    const date = new Date(today);
    date.setDate(date.getDate() + 90 + offset);
    return date.toISOString().slice(0, 10);
  });
}
