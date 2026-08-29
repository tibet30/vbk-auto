import { hotelDiamondFromTier } from "../../../shared/hotel-tiers.js";
import { getProductSegmentsApi, segmentsFromPayload } from "./vehicle-resource-api.js";

/**
 * VBK 当前草稿由套餐资源承载住宿。该阶段只读 getSegments，并要求每个正住宿段
 * 都已绑定一个具有合法主资源 ID 的套餐；不再打开资源配置页扫描 DOM。
 */
export async function ensureHotelResourceApi(page: any, product: any, productId: string) {
  const needsHotel = product.itinerary?.some((day: any) => Boolean(day.hotel));
  if (!needsHotel) return { skipped: "行程不含住宿", verified: true };
  const hotelTier = product.operations?.hotelTier;
  const diamond = hotelDiamondFromTier(hotelTier);
  if (!diamond) throw new Error(`酒店等级配置无效：${String(hotelTier || "未配置")}`);

  const payload = await getProductSegmentsApi(page, productId);
  const segments = segmentsFromPayload(payload);
  if (!segments.length) throw new Error("酒店资源接口回读未返回任何行程段");
  const lodging = segments.filter((segment) => Number(segment.segmentBase?.stayNights) > 0);
  if (!lodging.length) throw new Error("行程含住宿，但资源接口未返回正住宿段");
  const missing = lodging.filter((segment) => !Array.isArray(segment.packages)
    || !segment.packages.some((item: any) => Number(item.masterResourceId) > 0 && String(item.packageName ?? "").trim()));
  if (missing.length) {
    throw new Error(`正住宿段缺少可回读的套餐住宿资源：${missing.map((item) => item.segmentId).join("、")}`);
  }
  return {
    source: "package-api",
    packageManaged: true,
    verified: true,
    hotelTier,
    diamond,
    positiveSegmentCount: lodging.length,
    segmentIds: lodging.map((segment) => String(segment.segmentId)),
  };
}
