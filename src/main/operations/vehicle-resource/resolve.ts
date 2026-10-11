/**
 * resolveVehicleResource 主入口：
 *   - 拿 estimate（城市/天数/座位/车级）→ 接口查询 → bestResourceGroup 选最佳；
 *   - 未命中时退而求其次用"仅座位数"再次搜索；
 *   - 仍未命中则保留全程用车总成本但清掉旧匹配结果，加 note 说明，让运营人工干预；
 *   - 命中时只把真实可用的资源组 ID / 名称写入 operations.vehicleResource。
 *
 * 写入策略：
 *   - transport 缺省补 "charter"；
 *   - pickupCity 缺省补 estimate.city；
 *   - reusePickupForDropoff 缺省补 true；
 *   - 旧 ID/Name 拆掉，仅保留服务时长 / 公里数 / 总价等参数；
 *   - noteParts 文案区分"按总价命中" / "未指定预算" / "替换历史 ID" 三种情况。
 */

import type { Page } from "playwright";
import type { ProductDetail } from "../../../shared/contracts.js";
import { buildVehicleResourceQuery, targetVehicleTotalCost } from "./query.js";
import { searchVehicleResourceGroups } from "./search.js";
import { positiveInteger, textValue } from "./helpers.js";

import { matchVehicleResource } from "./matching.js";
import { projectVehicleResource } from "./projection.js";

export async function resolveVehicleResource(page: Page, product: ProductDetail) {
  const productData = product.product;
  const basic = productData.basicInfo && typeof productData.basicInfo === "object" && !Array.isArray(productData.basicInfo) ? productData.basicInfo as Record<string, unknown> : {};
  const operations = productData.operations && typeof productData.operations === "object" && !Array.isArray(productData.operations) ? productData.operations as Record<string, unknown> : {};
  const existingVehicle = operations.vehicleResource && typeof operations.vehicleResource === "object" && !Array.isArray(operations.vehicleResource)
    ? operations.vehicleResource as Record<string, unknown>
    : {};
  const estimate = buildVehicleResourceQuery({
    city: textValue(operations.pickupCity) || textValue(basic.meetingCity) || textValue(basic.destinationCity),
    days: positiveInteger(basic.days),
    serviceHoursPerDay: positiveInteger(existingVehicle.serviceHoursPerDay) || 8,
  });
  const targetTotalCost = targetVehicleTotalCost(productData);
  const match = await matchVehicleResource(estimate, targetTotalCost, query => searchVehicleResourceGroups(page, query));
  return projectVehicleResource(product, match);
}
