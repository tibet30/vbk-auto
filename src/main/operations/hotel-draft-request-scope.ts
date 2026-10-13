import type { VbkSessionRequestBrowser } from "../infrastructure/vbk-session-request.js";
import { segmentsFromPayload } from "../automation/ctrip/vehicle-resource-api.js";

/** A separate manual authorization permits only segment drafts, never publication. */
export function hotelDraftRequestScope(page: VbkSessionRequestBrowser, productId: string, assertCurrent: () => void): VbkSessionRequestBrowser {
  if (!page.vbkSessionFetch) throw new Error("酒店草稿执行需要原生 VBK 会话客户端");
  const allowed = new Set(["getSegments", "suggestDepartureCity", "saveProductMaintainType", "createProductDraft", "saveSegment"]);
  let segments: any[] = [];
  return {
    nativeOnly: true,
    evaluate: async () => { throw new Error("酒店草稿执行禁止页面脚本"); },
    vbkSessionFetch: async request => {
      assertCurrent();
      const url = new URL(request.endpoint);
      const action = url.pathname.split("/").at(-1)!;
      if (url.origin !== "https://online.ctrip.com" || url.pathname !== `/restapi/soa2/15638/${action}` || !allowed.has(action))
        throw new Error("酒店草稿授权禁止其他阶段、提交审核和发布");
      const body = request.body as any;
      if (action !== "suggestDepartureCity" && action !== "saveSegment" && String(body.productId) !== productId)
        throw new Error("酒店草稿请求的产品不一致");
      if (action === "createProductDraft" && body.module !== "segment") throw new Error("酒店草稿授权仅限资源模块");
      if (action === "saveProductMaintainType" && body.maintainType !== "P") throw new Error("酒店草稿维护类型无效");
      if (action === "saveSegment") assertHotelOnlySegment(body.segment, segments);
      const response = await page.vbkSessionFetch!({ ...request,
        headers: { ...request.headers, cookieorigin: "https://vbooking.ctrip.com" },
        referrer: `https://vbooking.ctrip.com/product/input/newResourceRule?productid=${encodeURIComponent(productId)}&from=vbk`,
        referrerPolicy: "no-referrer-when-downgrade" });
      if (action === "getSegments") segments = structuredClone(segmentsFromPayload(response.payload));
      return response;
    },
  };
}

function nonHotelProjection(segment: any, newSegment = false) {
  const next = structuredClone(segment);
  delete next.hotel;
  for (const key of ["stayNights", "minStayNights", "maxStayNights", "destinationCity"]) delete next.segmentBase?.[key];
  if (newSegment) {
    delete next.segmentId;
    delete next.segmentBase?.segmentNumber;
    delete next.segmentBase?.departureCity;
    delete next.segmentBase?.deleteable;
    delete next.segmentResourceGroups;
  }
  return next;
}
function assertHotelOnlySegment(segment: any, segments: any[]) {
  if (!segment) throw new Error("酒店草稿行程段无效");
  const existing = segments.find(item => String(item.segmentId) === String(segment.segmentId));
  const creating = Number(segment.segmentId) === 0;
  const before = creating ? segments.at(-1) : existing;
  if (!before || creating && (before.segmentBase?.deleteable !== true || Number(before.segmentBase?.stayNights) !== 0 || segment.segmentResourceGroups?.length))
    throw new Error("酒店草稿缺少可核验的行程段");
  // The platform owns a separate draft product identity. Only the IDs returned
  // by the immediately preceding getSegments(publicProductId) may be reused.
  if (String(segment.productId ?? "") !== String(before.productId ?? "")) throw new Error("酒店草稿行程段产品不一致");
  if (JSON.stringify(nonHotelProjection(segment, creating)) !== JSON.stringify(nonHotelProjection(before, creating)))
    throw new Error("酒店草稿授权禁止改写套餐、用车或其他资源");
}
