import type { PreparationGap } from "../../../shared/contracts-preparation.js";
import { normaliseTrafficLineConfig } from "../../../shared/contracts-traffic-line.js";
import { explicitlyDeclinesTrafficLine } from "../../../shared/traffic-line-intent.js";
import { trafficLinePlanMatchesExplicitCities } from "../../../shared/traffic-line-user-endpoints.js";
import { asObject } from "./common.js";

export function trafficGaps(product: Record<string, unknown>): PreparationGap[] {
  const gaps: PreparationGap[] = [];
  const operations = asObject(product.operations);
  const traffic = normaliseTrafficLineConfig(operations?.trafficLine);
  if (explicitlyDeclinesTrafficLine(product) && traffic && (traffic.enabled || traffic.variants.length || traffic.availability)) {
    gaps.push({
      code: "traffic", label: "大交通禁用配置",
      detail: "用户明确不录入大交通，需由受控核验入口清除错误启用的交通计划后再确认方案。",
      stage: "completion",
      node: "finalValidation",
    });
  }
  if (traffic?.enabled) {
    const available = new Set(traffic.availability?.availableVariants ?? []);
    const confirmed = traffic.variants.length > 0 && traffic.variants.every((variant) => available.has(variant));
    if (!traffic.availability || !confirmed || !trafficLinePlanMatchesExplicitCities(product, traffic.availability.endpointPlan)) {
      gaps.push({
        code: "traffic", label: "大交通端点可用性核验",
        detail: "已启用大交通时，必须核验用户指定抵达和离开城市的当前端点；旧城市核验不能用于确认方案，同城不得被推断为不可售。",
        stage: "completion",
        node: "finalValidation",
      });
    }
  }
  return gaps;
}

