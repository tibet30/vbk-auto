/**
 * 用车资源查询参数构建 + 目标总价解析 + 资源组清洗：
 *   - buildVehicleResourceQuery：把城市 / 天数 / 座位 / 车级 / 时长打包成查询参数；
 *   - targetVehicleTotalCost：解析产品 JSON 中的"全程预计用车总成本"；
 *   - sanitiseVehicleResource：把已存在的 vehicleResource 清洗为可写回的子集（清掉旧 ID/Name）。
 *
 * 价格向上取整步长 50 元：避免自动化写回 1234 元等与运营财务口径不对齐的细碎数字。
 * 历史产品可能保存为日价（requestedDailyCost），按产品天数一次性换算为总价。
 */

import type { VehicleResourceEstimateInput, VehicleResourceQuery } from "./types.js";
import { positiveInteger, positiveNumber, roundUpVehicleTotalCost, textValue } from "./helpers.js";

export function buildVehicleResourceQuery(input: VehicleResourceEstimateInput): VehicleResourceQuery {
  const city = textValue(input.city);
  if (!city) throw new Error("用车资源查询需要明确城市。");
  const days = positiveInteger(input.days) || 1;
  const seats = positiveInteger(input.seats) || 5;
  const tier = textValue(input.tier) || "经济";
  const serviceHoursPerDay = positiveInteger(input.serviceHoursPerDay) || 8;
  return {
    city,
    days,
    seats,
    tier,
    serviceHoursPerDay,
    query: `${seats}座${tier}`,
  };
}

export function targetVehicleTotalCost(product: Record<string, unknown>): number | undefined {
  const operations = product.operations && typeof product.operations === "object" && !Array.isArray(product.operations) ? product.operations as Record<string, unknown> : {};
  const vehicle = operations.vehicleResource && typeof operations.vehicleResource === "object" && !Array.isArray(operations.vehicleResource)
    ? operations.vehicleResource as Record<string, unknown>
    : {};
  // 用户曾在 UI 上清空过「全程预计用车总成本」——尊重这个意图，不再自动填充。
  if (vehicle.requestedTotalCostCleared === true || vehicle.requestedDailyCostCleared === true) return undefined;
  const requestedTotalCost = positiveNumber(vehicle.requestedTotalCost);
  if (requestedTotalCost) return roundUpVehicleTotalCost(requestedTotalCost);
  // 历史产品把成本保存为日价。读取时按产品天数一次性换算为总价；
  // 新的规划和人工保存不再写 requestedDailyCost。
  const legacyDailyCost = positiveNumber(vehicle.requestedDailyCost);
  const basic = product.basicInfo && typeof product.basicInfo === "object" && !Array.isArray(product.basicInfo)
    ? product.basicInfo as Record<string, unknown>
    : {};
  const days = positiveInteger(basic.days) || 1;
  if (legacyDailyCost) return roundUpVehicleTotalCost(legacyDailyCost * days);
  return undefined;
}

export function sanitiseVehicleResource(value: Record<string, unknown>, totalCost?: number) {
  const safeVehicle: Record<string, unknown> = {};
  const requestedTotalCost = positiveNumber(value.requestedTotalCost) || totalCost;
  const resourceGroupId = positiveInteger(value.resourceGroupId);
  const resourceGroupName = textValue(value.resourceGroupName);
  const serviceHoursPerDay = positiveInteger(value.serviceHoursPerDay);
  const serviceKilometersPerDay = positiveInteger(value.serviceKilometersPerDay);
  if (value.requestedTotalCostCleared === true || value.requestedDailyCostCleared === true) safeVehicle.requestedTotalCostCleared = true;
  if (requestedTotalCost) safeVehicle.requestedTotalCost = requestedTotalCost;
  if (resourceGroupId) safeVehicle.resourceGroupId = resourceGroupId;
  if (resourceGroupName) safeVehicle.resourceGroupName = resourceGroupName;
  if (serviceHoursPerDay) safeVehicle.serviceHoursPerDay = serviceHoursPerDay;
  if (serviceKilometersPerDay) safeVehicle.serviceKilometersPerDay = serviceKilometersPerDay;
  return safeVehicle;
}