/**
 * 根据 product 形态动态决定要执行的阶段顺序。
 *   - 无论是否含住宿，都先保存并提交行程，再进入 package；真实 VBK 新产品在
 *     行程提交前会锁住套餐管理，直接访问 packageManage 会被中断；
 *   - 价格或库存任一存在时附加 pricingInventory；
 *   - 行程含住宿时附加 hotelResource；
 *   - 私家团附加 vehicleResource；
 *   - 始终附加 terms，由 VBK 条款页直接写入，不依赖 AI 规划是否生成 commercial.terms；
 *   - trafficLine 未显式禁用时，在条款后创建飞机/火车往返子产品；
 *   - 始终追加 preflight 自检。
 *
 * 返回数组由调用方按顺序执行；run() / runOnePhase 都用同一个 draftPhases 列表保持重试对齐。
 */

import { parseProduct } from "../schema/schema.js";
import { requiresVehicleResource } from "../../../shared/product-form.js";
import { hasItineraryHotelStay } from "../../../shared/itinerary-hotel.js";

/**
 * 计算某个 product 当前应当跑的阶段序列。
 */
export function draftPhasesFor(product: {
  itinerary: Array<{hotel?: unknown; hotelCandidates?: unknown[]}>;
  operations?: {hotelSource?: string; trafficLine?: {enabled?: boolean}};
  commercial?: {pricing?: unknown; inventory?: unknown};
  sales: {productForm: ReturnType<typeof parseProduct>['sales']['productForm']};
}) {
  // Whether a hotel phase is required is a property of the itinerary, not of
  // when its Ctrip candidates happened to be persisted. Candidate completeness
  // is an approval/evaluator gate; the hotelResource handler still verifies
  // the durable candidate contract before writing VBK.
  const needsHotel = product.itinerary.some((day) => hasItineraryHotelStay(day.hotel));
  const phases = ["basic", "presentation", "itinerary", "package"];
  if (product.commercial?.pricing || product.commercial?.inventory) phases.push("pricingInventory");
  if (needsHotel) phases.push("hotelResource");
  if (requiresVehicleResource(product.sales.productForm)) phases.push("vehicleResource");
  phases.push("terms");
  // 母产品条款完成后默认继续创建并完善飞机、火车往返子产品。条款在前，
  // 是因为子产品条款 profile 必须从当前账号已验证的母产品协议取得；否则
  // 只能安全阻断，不能先留下无法激活的子产品壳。
  if (product.operations?.trafficLine?.enabled !== false) phases.push("trafficLine");
  phases.push("preflight");
  return phases;
}
