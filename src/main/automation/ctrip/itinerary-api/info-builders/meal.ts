/**
 * 餐饮节点：activeType=0（餐饮），tourDailyDinner 包含三餐元数据；
 *   - 默认费用自理（E）；调用方仅在酒店房型确认含早餐时给早餐传 mealsIncluded=true；
 *   - 儿童统一费用自理（业务默认值）；
 *   - takeoffTime 取餐次（B 07:00 / L 12:00 / S 18:00）+ takeTime=60 分钟。
 */

import { emptyTourDailyDinner, emptyTourDailyPoi } from "../info-skeletons.js";
import { commonInfoFields } from "./common.js";

export function buildMealInfo(args: {
  sort: number;
  mealKey: "B" | "L" | "S";
  /** 平台餐饮卡片的"补充说明"输入框。 */
  customDescription?: string;
  mealsIncluded: boolean;
}) {
  const { sort, mealKey, customDescription, mealsIncluded } = args;
  return {
    ...commonInfoFields({
      activeType: { key: 0, name: "餐饮" },
      sort,
      description: customDescription ?? "",
      takeoffTime: {
        key: null,
        name: mealKey === "B" ? "07:00" : mealKey === "L" ? "12:00" : "18:00",
      },
      takeTime: 60,
      costInclude: false,
    }),
    tourDailyPois: [emptyTourDailyPoi()],
    tourDailyDinner: emptyTourDailyDinner(mealKey, mealsIncluded),
  };
}