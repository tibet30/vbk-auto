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
import { logInfo } from "../../../shared/log-timestamp.js";
import { bestResourceGroup } from "./parse.js";
import { buildVehicleResourceQuery, sanitiseVehicleResource, targetVehicleTotalCost } from "./query.js";
import { searchVehicleResourceGroups } from "./search.js";
import { positiveInteger, textValue } from "./helpers.js";

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
  const primaryQuery = targetTotalCost ? `${estimate.query}${targetTotalCost}` : estimate.query;
  const payload = await searchVehicleResourceGroups(page, primaryQuery);
  // 如果精准查询无结果，退而求其次用更宽泛的关键词重试（去掉车级）。
  let selected = bestResourceGroup(payload, targetTotalCost, estimate.query);
  let matchedQuery = primaryQuery;
  if (!selected) {
    const fallbackQuery = `${estimate.seats}座`; // 去掉车级（经济/舒适），只用座位数
    if (fallbackQuery !== estimate.query) {
      const fallbackSearchQuery = targetTotalCost ? `${fallbackQuery}${targetTotalCost}` : fallbackQuery;
      const fallbackPayload = await searchVehicleResourceGroups(page, fallbackSearchQuery);
      selected = bestResourceGroup(fallbackPayload, targetTotalCost, estimate.query);
      if (selected) {
        matchedQuery = fallbackSearchQuery;
        logInfo("[VehicleResource] matched via fallback query", { original: primaryQuery, fallback: fallbackSearchQuery, resourceGroupId: selected.resourceGroupId });
      }
    }
  }
  if (!selected) {
    const {
      resourceGroupId: _oldResourceGroupId,
      resourceGroupName: _oldResourceGroupName,
      ...safeExistingVehicle
    } = sanitiseVehicleResource(existingVehicle, targetTotalCost);
    // 车辆资源库无匹配项：保留全程用车总成本 / 服务参数，但清掉旧 ID/Name，避免用户误以为新价格已匹配成功。
    return {
      product: {
        ...productData,
        operations: {
          ...operations,
          transport: operations.transport || "charter",
          vehicleResource: safeExistingVehicle,
        },
      },
      resolved: undefined,
      note: `VBK 资源库未返回与「${primaryQuery}」匹配的车辆资源组，请人工在 VBK 核查或调整搜索关键词后重试。`,
    };
  }

  const resolved = {
    query: matchedQuery,
    city: estimate.city,
    days: estimate.days,
    totalCost: targetTotalCost,
    resourceGroupId: selected.resourceGroupId,
    resourceGroupName: selected.resourceGroupName,
  };
  const {
    resourceGroupId: _oldResourceGroupId,
    resourceGroupName: _oldResourceGroupName,
    ...safeExistingVehicle
  } = sanitiseVehicleResource(existingVehicle, targetTotalCost);
  const vehicleResource = {
    ...safeExistingVehicle,
    resourceGroupId: resolved.resourceGroupId,
    resourceGroupName: resolved.resourceGroupName,
    serviceHoursPerDay: estimate.serviceHoursPerDay,
    serviceKilometersPerDay: positiveInteger(existingVehicle.serviceKilometersPerDay) || 300,
  };
  const nextProduct = {
    ...productData,
    operations: {
      ...operations,
      transport: operations.transport || "charter",
      pickupCity: textValue(operations.pickupCity) || estimate.city,
      reusePickupForDropoff: typeof operations.reusePickupForDropoff === "boolean" ? operations.reusePickupForDropoff : true,
      vehicleResource,
    },
  };
  const noteParts: string[] = [
    `${estimate.city}${estimate.days}天私家团按${matchedQuery}、每天${estimate.serviceHoursPerDay}小时在 VBK 资源库搜索。`,
  ];
  if (targetTotalCost) noteParts.push(`全程用车预算约 ${targetTotalCost} 元，按总价命中资源组：${resolved.resourceGroupName}（ID ${resolved.resourceGroupId}）。`);
  else noteParts.push(`命中资源组：${resolved.resourceGroupName}（ID ${resolved.resourceGroupId}）。`);
  if (existingVehicle.resourceGroupId && Number(existingVehicle.resourceGroupId) !== resolved.resourceGroupId) {
    noteParts.push("已替换先前的人工资源组 ID。");
  }
  return { product: nextProduct, resolved, note: noteParts.join(" ") };
}