import type { PreparationGap } from "../../../shared/contracts-preparation.js";
import { hasPersistedCommercialInventory, hasPersistedCommercialPricing } from "../commercial-stage.js";
import { asObject, textValue } from "./common.js";

export function commercialGaps(product: Record<string, unknown>): PreparationGap[] {
  const gaps: PreparationGap[] = [];
  const commercial = asObject(product.commercial);
  const push = (label: string, detail: string) => gaps.push({ code: "commercial", label, detail, stage: "completion", node: "commercial" });
  if (!textValue(commercial?.packageName)) push("套餐名称", "本地准备阶段需生成套餐名称，不能等到 VBK 套餐页再补。");
  if (!hasPersistedCommercialPricing(commercial?.pricing)) push("定价", "本地准备阶段需写入可审核的成人/儿童价和起订人数。");
  if (!hasPersistedCommercialInventory(commercial?.inventory)) push("库存班期", "本地准备阶段需写入班期起止日期和每日配额。");
  return gaps;
}
