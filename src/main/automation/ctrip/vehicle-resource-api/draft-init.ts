/**
 * vehicle-resource-api/draft-init：资源配置草稿初始化。
 *
 *   - ensureResourceSegmentsDraftApi：新建产品的 getSegments 可能只返回线上段，
 *     而没有可写的 draftProductSegments。酒店阶段先于用车阶段执行，故草稿
 *     初始化必须作为两者共享的前置条件；
 *   - initializeResourceSegmentsDraftApi：资源服务偶尔会返回过期的
 *     draftProductSegments 外壳，但 saveSegment 随后明确拒绝并报"产品还没有
 *     创建草稿"。调用方已经读回确认没有任何段内写入时，才可走这个受控的
 *     初始化和一次重试。
 */

import { vbkSessionRequest } from "../../../infrastructure/vbk-session-request.js";
import { assertVbkAckSuccess } from "../../../infrastructure/vbk-response-error.js";
import type { Segment } from "./types.js";
import { VBK_RESOURCE_HEAD } from "./types.js";
import { getProductSegmentsApi } from "./segment-apis.js";

export async function ensureResourceSegmentsDraftApi(page: any, productId: string) {
  const before: any = await getProductSegmentsApi(page, productId);
  if (Array.isArray(before?.draftProductSegments?.segments)) return before;
  return initializeResourceSegmentsDraftApi(page, productId);
}

export async function initializeResourceSegmentsDraftApi(page: any, productId: string) {
  const maintain = await vbkSessionRequest(page, {
    endpoint: "https://online.ctrip.com/restapi/soa2/15638/saveProductMaintainType",
    browserRequestTimeoutMs: 12_000,
    evaluateTimeoutMs: 15_000,
    errorLabel: "VBK 资源配置维护类型初始化",
    body: { contentType: "json", head: VBK_RESOURCE_HEAD, productId: Number(productId) || productId, maintainType: "P" },
  });
  assertVbkAckSuccess(maintain.payload, "VBK 资源配置维护类型初始化");
  const draft = await vbkSessionRequest(page, {
    endpoint: "https://online.ctrip.com/restapi/soa2/15638/createProductDraft",
    browserRequestTimeoutMs: 12_000,
    evaluateTimeoutMs: 15_000,
    errorLabel: "VBK 资源配置草稿初始化",
    body: { contentType: "json", head: VBK_RESOURCE_HEAD, module: "segment", productId: Number(productId) || productId },
  });
  assertVbkAckSuccess(draft.payload, "VBK 资源配置草稿初始化");
  const current: any = await getProductSegmentsApi(page, productId);
  if (!Array.isArray(current?.draftProductSegments?.segments)) {
    throw new Error("VBK 资源配置草稿初始化后仍未返回可写行程段");
  }
  return current;
}

export type { Segment };