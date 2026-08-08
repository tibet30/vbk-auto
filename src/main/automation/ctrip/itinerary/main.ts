// @ts-nocheck
/**
 * 行程描述（itinerary）面板自动化主入口：fillItineraryDraft。
 *   - 先确保跳到产品编辑页并点开「行程描述」tab，等到 title textarea 行数 == itinerary.length；
 *   - 按 day 循环：填标题 / 包车选项 / 接送站 / 餐食 / 酒店 / 服务时间 / 其他节点补充说明；
 *   - 全部天填完后点「存为草稿」并经 saveThenAdvance 等「套餐管理」tab 解锁（提交审核并下一步）。
 * 顶部带 `// @ts-nocheck`，disambiguator 由 caller 注入。
 */

import { delay } from "../utils.js";
import { clickSection, clickSafeSave, saveThenAdvance } from "../tabs.js";
import { productEditorUrl } from "../../constants.js";
import { dayScopeFor, ensureOtherCard, ensureServiceTimeRange, clickExact } from "./common.js";
import { fillHotelCard, fillMealCards } from "./cards.js";
import { fillPickupAndDropoff, handleAirportTrainModal } from "./stations.js";

/**
 * 行程描述面板写入主函数。返回 { savedWith, days }。
 *   - 上方空行（标题还没渲染）时主动 jump + clickSection + 轮询；
 *   - 包车与否由 operations.transport === "charter" 决定；
 *   - 第 0 天的「其他」card 默认排在最前（afterFirstCard=true），其它天追加；
 *   - 全部填完走「存为草稿 + 提交审核并下一步」二段提交。
 */
export async function fillItineraryDraft(page, product, options = {}) {
  const disambiguator = options?.disambiguator;
  const productId = options?.productId || product.productId || "";
  let titleInputs = page.locator('textarea[placeholder^="请输入标题"]');
  if ((await titleInputs.count()) !== product.itinerary.length) {
    await page.goto(productEditorUrl(productId), { waitUntil: "domcontentloaded" });
    titleInputs = page.locator('textarea[placeholder^="请输入标题"]');
  }
  if ((await titleInputs.count()) !== product.itinerary.length) {
    await clickSection(page, "行程描述");
    titleInputs = page.locator('textarea[placeholder^="请输入标题"]');
  }
  const titleReady = await pollUntilLocal(
    titleInputs,
    (loc) => loc.count().then((n) => n === product.itinerary.length),
    3_000,
  );
  if (!titleReady) {
    await assertCount(titleInputs, product.itinerary.length, "每日标题输入框");
  }

  for (let index = 0; index < product.itinerary.length; index += 1) {
    const day = product.itinerary[index];
    const titleInput = titleInputs.nth(index);
    await titleInput.fill(day.title);
    const titleAfterFill = (await titleInput.inputValue()).trim();
    if (!titleAfterFill) {
      throw new Error(`第 ${day.day} 天标题未成功写入（输入框为空）。`);
    }
    const scope = dayScopeFor(titleInput);
    await assertCount(scope, 1, `第 ${day.day} 天行程区域`);
    if (product.operations?.transport === "charter") {
      await clickExact(scope, "包车", `第 ${day.day} 天包车选项`);
    }
    await fillPickupAndDropoff(
      page,
      scope,
      index,
      product.itinerary.length,
      product.operations ?? {
        reusePickupForDropoff: true,
      },
      { disambiguator, product },
    );
    await fillMealCards(scope, day, product.operations?.mealsIncluded === true);
    if (product.operations) {
      await fillHotelCard(page, scope, day, product.operations);
    }
    await ensureServiceTimeRange(scope, day);
    const otherCard = await ensureOtherCard(page, scope, {
      afterFirstCard: index === 0,
    });
    const unlimited = otherCard.getByText("不限", { exact: true });
    if (await unlimited.count()) await unlimited.first().click();
    const description = otherCard.locator('textarea[placeholder="请输入补充说明"]');
    if (!(await description.count())) {
      throw new Error(`第 ${day.day} 天"其他"节点缺少补充说明`);
    }
    await description.first().fill(day.description);
    const descriptionAfterFill = (await description.first().inputValue()).trim();
    if (!descriptionAfterFill) {
      throw new Error(`第 ${day.day} 天"其他"补充说明未成功写入（输入框为空）。`);
    }
  }

  const savedWith = await clickSafeSave(page, ["存为草稿"]);
  const submitResult = await saveThenAdvance(page, {
    phase: "ItineraryDraft",
    targetTabLabel: "套餐管理",
    saveButtonNames: ["存为草稿"],
    targetTabLabels: ["套餐管理"],
    isTargetUrl: () => false,
    nextButtonLabel: "提交审核并下一步",
    savedWith,
  });
  if (!submitResult?.advanced) {
    throw new Error("ItineraryDraft 未提交通过：未进入下一阶段");
  }
  await delay(3_000);
  return { savedWith, days: product.itinerary.length };
}

/**
 * 测试切片占位：source-slicing 锚点，运行时不会被调用（行程阶段实际用 stations 的开关）。
 */
async function chooseRadioValue(_page, _groupId, _value, _description) { return null; }


declare function assertCount(locator: any, expected: number, description: string): Promise<any>;
declare function pollUntilLocal(locator: any, predicate: any, timeoutMs?: number): Promise<boolean>;