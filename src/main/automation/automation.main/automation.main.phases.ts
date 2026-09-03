/**
 * 根据 product 形态动态决定要执行的阶段顺序。
 *   - 无论是否含住宿，都先保存并提交行程，再进入 package；真实 VBK 新产品在
 *     行程提交前会锁住套餐管理，直接访问 packageManage 会被中断；
 *   - 价格或库存任一存在时附加 pricingInventory；
 *   - 行程含住宿时附加 hotelResource；
 *   - 私家团附加 vehicleResource；
 *   - 始终附加 terms，由 VBK 条款页直接写入，不依赖 AI 规划是否生成 commercial.terms；
 *   - 始终追加 preflight 自检。
 *
 * 返回数组由调用方按顺序执行；run() / runOnePhase 都用同一个 draftPhases 列表保持重试对齐。
 */

import { parseProduct } from "../schema/schema.js";
import { requiresVehicleResource } from "../../../shared/product-form.js";
import { HOTEL_RESOURCE_MIN_CANDIDATE_COUNT } from "../../../shared/hotel-candidate-counts.js";

/**
 * 计算某个 product 当前应当跑的阶段序列。
 */
export function draftPhasesFor(product: ReturnType<typeof parseProduct>) {
  const hasResolvedHotelCandidates = product.itinerary.some((day) => Array.isArray(day.hotelCandidates)
    && day.hotelCandidates.length >= HOTEL_RESOURCE_MIN_CANDIDATE_COUNT);
  const needsHotel = hasResolvedHotelCandidates || (product.operations?.hotelSource !== "nonPlatform"
    && product.itinerary.some((day) => Boolean(day.hotel)));
  const phases = ["basic", "presentation", "itinerary", "package"];
  if (product.commercial?.pricing || product.commercial?.inventory) phases.push("pricingInventory");
  if (needsHotel) phases.push("hotelResource");
  if (requiresVehicleResource(product.sales.productForm)) phases.push("vehicleResource");
  phases.push("terms");
  phases.push("preflight");
  return phases;
}
