/**
 * 线路及交通 SOA 适配器。
 *
 * 请求与既有 itinerary API 一样走 `postSoa` → `vbkSessionRequest`，因此始终
 * 使用 BrowserView 的已登录会话；本文件不复制扩展里的静态 cid 或 Cookie。
 */

import {
  SOHEAD,
  postSoa,
  type ApiPage,
} from "../itinerary-api/transport.js";
import type {
  TrafficLineCreateTemplate,
  TrafficLineExistingChild,
  TrafficLineSaveRequest,
} from "./types.js";

export const GET_PACKAGE_PRODUCT_DETAIL_URL = "https://online.ctrip.com/restapi/soa2/15638/getPackageProductDetail";
export const SAVE_LINE_INFO_URL = "https://online.ctrip.com/restapi/soa2/15638/saveLineInfo";

export async function getTrafficLineCreateTemplate(
  page: ApiPage,
  parentProductId: string,
): Promise<TrafficLineCreateTemplate> {
  const { payload } = await postSoa(page, GET_PACKAGE_PRODUCT_DETAIL_URL, {
    contentType: "json",
    head: SOHEAD,
    parentProductId,
    subProductId: 0,
  }, "读取线路及交通母产品模板");
  const generalInfoDto = asRecord(payload.generalInfoDto);
  const subLineInfoDto = asRecord(payload.subLineInfoDto);
  if (!generalInfoDto || !subLineInfoDto) {
    throw new Error("读取线路及交通母产品模板失败：响应缺少 generalInfoDto 或 subLineInfoDto。");
  }
  return { generalInfoDto, subLineInfoDto };
}

export async function saveTrafficLineChild(
  page: ApiPage,
  request: TrafficLineSaveRequest,
): Promise<{ productId: string }> {
  const { payload } = await postSoa(page, SAVE_LINE_INFO_URL, {
    contentType: "json",
    head: SOHEAD,
    parentProductId: request.parentProductId,
    generalInfoDto: request.generalInfoDto,
    subLineInfoDto: request.subLineInfoDto,
    tags: [],
    isVendorHasGoldGuide: "F",
  }, `创建${request.lineDescription}子产品`);
  const productId = findProductId(payload);
  if (!productId) throw new Error(`创建${request.lineDescription}子产品失败：响应缺少 subProductId。`);
  return { productId };
}

/** 将页面/接口读取到的子产品项收敛为创建编排所需字段。 */
export function normaliseTrafficLineExistingChildren(value: unknown): TrafficLineExistingChild[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const record = asRecord(item);
    if (!record) return [];
    const productId = productIdentifier(record.subProductId) || productIdentifier(record.productId);
    const lineDescription = text(record.lineDescription);
    if (!productId || !lineDescription) return [];
    const packageId = text(record.packageId);
    const activeValue = record.isActiveInPackage ?? record.isActiveInProduct ?? record.active;
    const active = activeValue === true || activeValue === "T";
    return [{ productId, lineDescription, ...(packageId ? { packageId } : {}), ...(active ? { active: true } : {}) }];
  });
}

function findProductId(payload: Record<string, unknown>): string {
  const direct = text(payload.subProductId);
  if (direct) return direct;
  const data = asRecord(payload.data);
  return data ? text(data.subProductId) : "";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}

function productIdentifier(value: unknown): string {
  const id = text(value);
  return /^\d+$/.test(id) && !/^0+$/.test(id) ? id : "";
}
