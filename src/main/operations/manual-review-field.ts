/**
 * 运营手工复核阶段里把单个字段写入 product JSON 的工具。
 * 仅依赖 shared 契约，不引入 VBK 浏览器，保持纯函数特性便于测试。
 *
 * 支持的字段（用 `field` discriminator 拆分）：
 *  - pricing                  : commercial.pricing.adult / child / minimumTravelers / currency（保留现有 cost）
 *  - inventory                : commercial.inventory.startDate / endDate / dailyQuota
 *  - basicInfoSubtitle        : basicInfo.subtitle
 *  - vehicleResource          : operations.vehicleResource.requestedTotalCost
 *  - itinerarySpotPoi / itinerarySpotKind / itinerarySpotRemove : 复用 manual-review-itinerary-field
 *  - butlerContact            : operations.bookingControls.butler（null 表示清空）
 *  - productCover             : presentation.cover（ctripLibrary / manualUpload 二选一）
 *
 * 写入策略：
 *   - 数值字段：> 0（pricing.adult / requestedTotalCost）；
 *     pricing.child >= 0；pricing.minimumTravelers 必须是正整数；
 *     requestedTotalCost > 0（可独立为 null）；
 *   - 文本字段：trim 后非空，> 1 字符（与 schema subtitle 同步）；
 *   - 真实资源组 ID / 名称只能由 VBK 匹配回填，手动复核入口不写。
 *   - 与 AI 写入路径完全解耦：product 走 schema 校验后才落库。
 *   - productCover：源 manualUpload 时 fileId 必须先经 cover:uploadManual
 *     写入本地副本；该 helper 只校验形状，不验证文件存在——文件存在由
 *     applyCoverField 在 retainManualCoverFile 阶段校验。
 *
 * 拆分子文件：
 *   - util.ts        : objectValue / isIsoDate / repairLegacyCoverQuality
 *   - pricing.ts     : applyPricing / applyInventory
 *   - basic.ts       : applyBasicInfoSubtitle / applyVehicleResource
 *   - butler.ts      : applyButlerContact / isContactCardSelection
 *   - cover.ts       : applyProductCover（ctripLibrary + manualUpload）
 *   - index.ts       : 本 barrel，dispatch applyManualReviewField
 */

import type { ManualReviewFieldInput } from "../../shared/contracts.js";
import { normaliseItinerarySupport } from "../../shared/itinerary-support-arrangements.js";
import { reconcileHotelStays } from "../../shared/reconcile-hotel-stays.js";
import { applyItinerarySpotKind, applyItinerarySpotPoi, applyItinerarySpotRemove } from "./manual-review-itinerary-field.js";
import { applyPricing, applyInventory } from "./manual-review-field/pricing.js";
import { applyBasicInfoSubtitle, applyVehicleResource } from "./manual-review-field/basic.js";
import { applyButlerContact } from "./manual-review-field/butler.js";
import { applyProductCover } from "./manual-review-field/cover.js";
import { repairLegacyCoverQuality } from "./manual-review-field/util.js";

/**
 * 把 input 中的合法字段覆盖到 product，返回新 product，调用方决定是否落库。
 *  - 任何子项校验失败立即抛错，不写一半；
 *  - 不修改原 product 的副本（structuredClone）。
 */
export function applyManualReviewField(product: Record<string, unknown>, input: ManualReviewFieldInput): Record<string, unknown> {
  let next: Record<string, unknown>;
  switch (input.field) {
    case "pricing": next = applyPricing(product, input.adult, input.child, input.minimumTravelers); break;
    case "inventory": next = applyInventory(product, input.startDate, input.endDate, input.dailyQuota); break;
    case "basicInfoSubtitle": next = applyBasicInfoSubtitle(product, input.subtitle); break;
    case "vehicleResource": next = applyVehicleResource(product, input); break;
    case "itinerarySpotPoi": next = applyItinerarySpotPoi(product, input); break;
    case "itinerarySpotKind": next = applyItinerarySpotKind(product, input); break;
    case "itinerarySpotRemove": next = applyItinerarySpotRemove(product, input); break;
    case "butlerContact": next = applyButlerContact(product, input.selection); break;
    case "productCover": next = applyProductCover(product, input.cover); break;
    default: {
      // 编译期已穷尽，运行期兜底
      const exhaustive: never = input;
      throw new Error(`不支持的 ManualReviewFieldInput：${(exhaustive as { field?: string }).field ?? "unknown"}`);
    }
  }
  if (Array.isArray(next.itinerary)) next.itinerary = next.itinerary.map(day =>
    day && typeof day === "object" && !Array.isArray(day) ? normaliseItinerarySupport(day) : day);
  return repairLegacyCoverQuality(reconcileHotelStays(next));
}