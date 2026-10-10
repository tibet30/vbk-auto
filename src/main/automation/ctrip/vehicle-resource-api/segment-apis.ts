/**
 * vehicle-resource-api/segment-apis：15638 系列接口的核心封装。
 *   - getProductSegmentsApi：拉取 resources 草稿 + 正式段；
 *   - saveProductSegmentApi：保存一个完整行程段；
 *   - resolveResourceSegmentCityApi：精确匹配住宿城市（unique cityName）；
 *   - buildLodgingResourceSegment：以平台末尾空段为模板新建住宿段；
 *   - submitResourceSegmentsApi：提交资源配置草稿（不等于产品审核）；
 *   - futureSchedule：submitSegments 要求的日期数组（90 天后 + offset）。
 */

import { vbkSessionRequest } from "../../../infrastructure/vbk-session-request.js";
import { assertVbkAckSuccess } from "../../../infrastructure/vbk-response-error.js";
import type { ResourceCity, Segment } from "./types.js";
import { VBK_RESOURCE_HEAD } from "./types.js";

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
export async function resolveResourceSegmentCityApi(page: any, cityName: string): Promise<ResourceCity> {
  const expected = cityName.trim();
  if (!expected) throw new Error("住宿资源行程段缺少城市名称");
  const response = await vbkSessionRequest(page, {
    endpoint: "https://online.ctrip.com/restapi/soa2/15638/suggestDepartureCity",
    browserRequestTimeoutMs: 12_000,
    evaluateTimeoutMs: 15_000,
    errorLabel: "VBK 住宿城市查询",
    headers: { cookieorigin: "https://vbooking.ctrip.com" },
    body: { contentType: "json", head: VBK_RESOURCE_HEAD, keyword: expected },
  });
  assertVbkResourceResponse(response.payload, "VBK 住宿城市查询");
  const cities = Array.isArray((response.payload as any)?.cities)
    ? (response.payload as any).cities
    : [];
  const matches = cities.filter((city: any) => String(city?.cityName ?? "").trim() === expected);
  if (matches.length !== 1 || Number(matches[0]?.cityId) <= 0) {
    throw new Error(`住宿城市「${expected}」无法唯一匹配：${matches.length} 个精确候选`);
  }
  return structuredClone(matches[0]);
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