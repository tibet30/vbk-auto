/**
 * vehicle-resource.ts 的对外类型：
 *   - VehicleResourceEstimateInput：调用方传入的原始参数（estimate 阶段）；
 *   - VehicleResourceQuery：经 buildVehicleResourceQuery 归一后的 VBK 查询参数；
 *   - ResolvedVehicleResource：解析后的"已命中资源组"（id + name + 上下文）。
 */

export interface VehicleResourceEstimateInput {
  city?: string;
  days?: number;
  seats?: number;
  tier?: string;
  serviceHoursPerDay?: number;
}

export interface VehicleResourceQuery {
  city: string;
  days: number;
  seats: number;
  tier: string;
  serviceHoursPerDay: number;
  query: string;
}

export interface ResolvedVehicleResource {
  query: string;
  city: string;
  days: number;
  totalCost?: number;
  resourceGroupId: number;
  resourceGroupName: string;
}