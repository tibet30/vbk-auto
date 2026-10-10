/**
 * traffic-line/itinerary.ts（risk-plans 子模块）：
 *   applyRequiredPoiRiskPlans：VBK 在套餐有效化时会再次校验风险 POI，
 *   子产品复制出的行程可能保留候选 riskPlanList，却没有选中的 riskPlanCode；
 *   先锁定费用口径，再采用该口径内 VBK 排在首位的默认方案，绝不跨口径猜测。
 *
 *   riskCostInclude：deduce 节点 / dailyPoi.costInclude → "T" | "F" | null：
 *     - 显式 true / "T" → "T"，false / "F" → "F"；
 *     - 后缀名"不含" → "F"，否则含 → "T"；
 *     - 其余 null。
 */

import { list, record, text, type JsonRecord } from "../client.js";

/**
 * VBK 会在套餐有效化时再次校验风险 POI。子产品复制出的行程可能保留候选
 * riskPlanList，却没有选中的 riskPlanCode；先锁定费用口径，再采用该口径内
 * VBK 排在首位的默认方案，绝不跨口径猜测。
 */
export function applyRequiredPoiRiskPlans(tourInfo: JsonRecord): JsonRecord {
  const result = structuredClone(tourInfo);
  for (const day of list(result.tourDailyDescriptions)) {
    for (const node of list(day.tourDailyInfos)) {
      for (const dailyPoi of list(node.tourDailyPois)) {
        const poi = record(dailyPoi.poi);
        if (!poi || poi.isRisk !== true || text(dailyPoi.riskPlanCode)) continue;
        const expected = riskCostInclude(dailyPoi, node);
        const available = list(poi.riskPlanList).filter((plan) => {
          const code = text(plan.riskPlanCode);
          const description = text(plan.riskPlanDesc);
          return code && description;
        });
        const matching = expected === null
          ? available
          : available.filter((plan) => text(plan.costInclude) === expected);
        const applicability = new Set(available.map((plan) => text(plan.costInclude)).filter(Boolean));
        const candidates = matching.length ? matching : applicability.size === 1 ? available : [];
        if (!candidates.length) {
          throw new Error(`风险 POI「${text(poi.poiName) || text(poi.poiId)}」无法唯一确认备选方案；未激活交通子产品。`);
        }
        // 同一费用口径下，VBK riskPlanList 顺序就是平台默认优先级；只在已确认
        // 口径内取首项，不跨口径猜测。
        dailyPoi.riskPlanCode = candidates[0]!.riskPlanCode;
        dailyPoi.riskPlanDesc = candidates[0]!.riskPlanDesc;
      }
    }
  }
  return result;
}

function riskCostInclude(dailyPoi: JsonRecord, node: JsonRecord): "T" | "F" | null {
  const explicit = dailyPoi.costInclude ?? node.costInclude;
  if (explicit === true || explicit === "T") return "T";
  if (explicit === false || explicit === "F") return "F";
  const suffix = text(record(dailyPoi.suffixName)?.name);
  if (/不含/.test(suffix)) return "F";
  if (/含/.test(suffix)) return "T";
  return null;
}