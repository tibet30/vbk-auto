// @ts-nocheck
/**
 * 行程描述里「餐饮 / 酒店」card 的写入函数：
 *   - fillMealCards：按早 / 午 / 晚 3 张 card，写入餐饮类型、「费用自理」（当 mealsIncluded=false）、
 *     补充说明；
 *   - fillHotelCard：写入酒店时间不限、平台酒店来源、按 hotelTier 选钻级、补充说明。
 * 顶部带 `// @ts-nocheck`，dayScope 为动态传入的 page 子 locator。
 */

import { delay, selectVisibleOption } from "../utils.js";
import { cardsByPrefix, clickByCandidates, clickExact } from "./common.js";

/**
 * 餐饮 3 个 card 写入：
 *   - 断言恰好 3 张 card（早 / 午 / 晚），结构异常抛错；
 *   - 每张 card 点击「不限」与餐饮类型；
 *   - mealsIncluded=false 时勾两个「费用自理」；
 *   - mealDescriptions 给 3 个补充说明 textarea 复用。
 */
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

/**
 * 单天酒店 card 写入：
 *   - 0 张 card 时直接 return（行程无住宿）；
 *   - 点击「不限」、选「携程平台酒店」（候选包含别名）；
 *   - 按 operations.hotelTier 拼「当地N钻酒店/-N」关键字挑钻级；
 *   - hotelDescription / hotel / hotelTier 回填到补充说明。
 */
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