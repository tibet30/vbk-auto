import type { ProductDetail } from "../../../shared/contracts.js";
import { sanitiseVehicleResource } from "./query.js";
import { positiveInteger, textValue } from "./helpers.js";
import type { matchVehicleResource } from "./matching.js";

/** Builds the next product; only the existing mutation service persists it. */
export function projectVehicleResource(product: ProductDetail, match: Awaited<ReturnType<typeof matchVehicleResource>>) {
  const productData = product.product;
  const operations = productData.operations && typeof productData.operations === "object" && !Array.isArray(productData.operations) ? productData.operations as Record<string, unknown> : {};
  const existingVehicle = operations.vehicleResource && typeof operations.vehicleResource === "object" && !Array.isArray(operations.vehicleResource)
    ? operations.vehicleResource as Record<string, unknown> : {};
  const { estimate, targetTotalCost, primaryQuery, matchedQuery, selected } = match;
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
