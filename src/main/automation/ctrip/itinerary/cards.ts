// @ts-nocheck

import { delay, selectVisibleOption } from "../utils.js";
import { cardsByPrefix, clickByCandidates, clickExact } from "./common.js";

export async function fillMealCards(dayScope, day, mealsIncluded = false) {
  const mealCards = await cardsByPrefix(dayScope, "餐饮");
  if (mealCards.length !== 3) {
    throw new Error(`第 ${day.day} 天餐饮节点数量异常：期望 3，实际 ${mealCards.length}`);
  }
  const types = ["早餐", "午餐", "晚餐"];
  const descriptions = day.mealDescriptions ?? [day.meals, day.meals, day.meals];

  for (let index = 0; index < 3; index += 1) {
    const card = mealCards[index];
    await clickExact(card, "不限", `第 ${day.day} 天${types[index]}时间`);
    await clickExact(card, types[index], `第 ${day.day} 天餐饮类型`);
    if (!mealsIncluded) {
      const selfPay = card.getByText("费用自理", { exact: true });
      await assertCount(selfPay, 2, `第 ${day.day} 天${types[index]}费用自理选项`);
      await selfPay.nth(0).click({ force: true });
      await selfPay.nth(1).click({ force: true });
    }
    const supplement = card.locator('textarea[placeholder="请输入补充说明"]');
    if (await supplement.count()) await supplement.first().fill(descriptions[index]);
  }
}

export async function fillHotelCard(page, dayScope, day, operations) {
  const hotelCards = await cardsByPrefix(dayScope, "酒店");
  if (hotelCards.length === 0) return;
  if (hotelCards.length !== 1) {
    throw new Error(`第 ${day.day} 天酒店节点数量异常：期望 1，实际 ${hotelCards.length}`);
  }
  const hotelCard = hotelCards[0];
  await clickExact(hotelCard, "不限", `第 ${day.day} 天酒店时间`);
  const platformSourceCandidates = [
    "使用携程平台酒店",
    "携程平台酒店",
  ];
  const sourceSet = await clickByCandidates(hotelCard, platformSourceCandidates, "酒店来源");
  if (!sourceSet) {
    console.warn(`[fillHotelCard] 第 ${day.day} 天酒店来源未命中：${platformSourceCandidates.join(" / ")}，保留默认值继续后续录入`);
  }
  await delay(300);
  const combos = hotelCard.getByRole("combobox");
  if (!(await combos.count())) throw new Error(`第 ${day.day} 天酒店名称选择器缺失`);
  await combos.last().click();
  await delay(300);
  const tierKeyword = operations.hotelTier && /4钻/.test(operations.hotelTier)
    ? "当地4钻酒店/-4"
    : "当地3钻酒店/-3";
  await selectVisibleOption(page, tierKeyword);
  const supplement = hotelCard.locator('textarea[placeholder="请输入补充说明"]');
  if (await supplement.count()) {
    await supplement.first().fill(day.hotelDescription || day.hotel || `依据产品配置：${operations.hotelTier}`);
  }
}

declare function assertCount(locator: any, expected: number, description: string): Promise<any>;

