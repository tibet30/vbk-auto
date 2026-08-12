// @ts-nocheck
/**
 * 行程描述里「餐饮 / 酒店」card 的写入函数：
 *   - fillMealCards：按早 / 午 / 晚 3 张 card，写入餐饮类型、1 小时时长与「不含餐」状态、
 *     补充说明；
 *   - getAvailableHotelSelectors：枚举 hotelCard 内所有 role=combobox，过滤掉
 *     ancestor 带 `.ant-select.ant-select-disabled` 的「具体时间」下拉，返回真正可
 *     编辑的酒店名称 combobox；
 *   - fillHotelCard：写入酒店时间不限、平台酒店来源、按 hotelTier 选钻级、补充说明。
 *
 * VBK 真实 DOM 提示：酒店 card 内通常带 2 个「具体时间」的 ant-select-disabled
 * combobox（不可点的「不限」时间下拉）+ 1 个「酒店名称」可编辑 combobox。早期版本
 * 用 `getByRole("combobox").last()` 会把禁用时间下拉误当酒店选择器，并触发
 * `selectVisibleOption` 抛「当地N钻酒店/-N 期望 1 实际 0」错误。本文件以
 * `.ant-select-disabled` 祖先为最稳健的禁用判据（辅以 input 自身 disabled /
 * 父文本「具体时间」兜底），把 0 / 1 / 多于 1 三种情况分别走「跳过钻级并写补充说
 * 明」、「原有点击+选词」、「明确失败」三条互不交叉的分支。
 *
 * 顶部带 `// @ts-nocheck`，dayScope 为动态传入的 page 子 locator。
 */

import { delay, assertCount, selectVisibleOption } from "../utils.js";
import {
  cardsByPrefix,
  clickByCandidates,
  clickExact,
  ensureCheckboxChecked,
} from "./common.js";
import { logWarn } from "../../../../shared/log-timestamp.js";

/**
 * 餐饮 3 个 card 写入：
 *   - 断言恰好 3 张 card（早 / 午 / 晚），结构异常抛错；
 *   - 每张 card 点击「1小时」与餐饮类型；
 *   - 每张 card 勾两个「不含餐」（成人 / 儿童）；
 *   - mealDescriptions 给 3 个补充说明 textarea 复用。
 */
export async function fillMealCards(dayScope, day, mealsIncluded = false) {
  const mealCards = await cardsByPrefix(dayScope, "餐饮");
  if (mealCards.length !== 3) {
    throw new Error(`第 ${day.day} 天餐饮节点数量异常：期望 3，实际 ${mealCards.length}`);
  }
  const types = ["早餐", "午餐", "晚餐"];
  const descriptions = [
    "早餐以房间是否含餐为准",
    "午餐自理",
    "晚餐自理",
  ];

  for (let index = 0; index < 3; index += 1) {
    const card = mealCards[index];
    await clickExact(card, "1小时", `第 ${day.day} 天${types[index]}用餐时间`);
    await clickExact(card, types[index], `第 ${day.day} 天餐饮类型`);
    const noMeal = card.getByText("不含餐", { exact: true });
    await assertCount(noMeal, 2, `第 ${day.day} 天${types[index]}不含餐选项`);
    // 成人 / 儿童两个不含餐选项均需勾选；走 ensureCheckboxChecked 保证幂等
    // （phase-retry 时第二次点击 ant-checkbox 会反勾回未选，必须先判状态再点）。
    await ensureCheckboxChecked(noMeal.nth(0));
    await ensureCheckboxChecked(noMeal.nth(1));
    const supplement = card.locator('textarea[placeholder="请输入补充说明"]');
    if (await supplement.count()) await supplement.first().fill(descriptions[index]);
  }
}

/**
 * 从 hotelCard 内所有 role=combobox 中挑出「真正可编辑的酒店名称 combobox」：
 *   - 主判据：沿 DOM 向上找到最近的 `.ant-select` 祖先，必须存在且不携带
 *     `ant-select-disabled` 类（VBK 真实 DOM 里「具体时间」下拉的标记）；
 *   - 防御判据：input 自身的 `disabled` 属性 / `aria-disabled="true"`，以及父节点
 *     文本含「具体时间」—— 任一命中即视为时间下拉被剔除。
 * 显式导出供 fillHotelCard 复用 + 配套测试断言三类分支（0 / 1 / 多于 1）。
 */
export async function getAvailableHotelSelectors(combos) {
  const available = [];
  const total = await combos.count();
  for (let index = 0; index < total; index += 1) {
    const combo = combos.nth(index);
    // 1) 主判据：最近 .ant-select 祖先带 ant-select-disabled → 时间下拉，跳过
    const antSelectClass = await combo
      .evaluate((el) => {
        let node = el.parentElement;
        while (node) {
          const cls = (typeof node.className === "string"
            ? node.className
            : node.className?.baseVal || ""
          )
            .toString()
            .trim();
          if (cls.includes("ant-select")) return cls;
          node = node.parentElement;
        }
        return "";
      })
      .catch(() => "");
    if (antSelectClass.includes("ant-select-disabled")) continue;
    if (!antSelectClass) continue; // 不是 ant-select 包装的 combobox 也不视为酒店选择器
    // 2) 防御判据：input 自身 / aria / 父文本
    if (!(await combo.isVisible().catch(() => false))) continue;
    const disabled = await combo.getAttribute("disabled").catch(() => null);
    const ariaDisabled = await combo.getAttribute("aria-disabled").catch(() => null);
    if (disabled !== null || ariaDisabled === "true") continue;
    const parentText = await combo
      .locator("xpath=..")
      .textContent()
      .catch(() => "");
    if (/具体时间/.test(parentText || "")) continue;
    available.push(combo);
  }
  return available;
}

/**
 * 单天酒店 card 写入：
 *   - 0 张 card 时直接 return（行程无住宿）；
 *   - 点击「不限」、选「携程平台酒店」（候选包含别名）；
 *   - 按 operations.hotelTier 拼「当地N钻酒店/-N」关键字挑钻级；
 *   - hotelDescription / hotel / hotelTier 回填到补充说明。
 *
 * 钻级选择器分支契约：
 *   - 0 个可用：跳过 selectVisibleOption，仅写补充说明；warn 一行让运营能在日志
 *     里看到「酒店名称选择器缺失，由后续 ensureHotelResource 补全」。
 *   - 1 个可用：保持既有的 click + selectVisibleOption(tierKeyword) 不变。
 *   - 多于 1 个：抛「明确失败」错误，避免误选导致下游酒店资源错配。
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
    logWarn(`[fillHotelCard] 第 ${day.day} 天酒店来源未命中：${platformSourceCandidates.join(" / ")}，保留默认值继续后续录入`);
  }
  await delay(300);
  const combos = hotelCard.getByRole("combobox");
  const availableCombos = await getAvailableHotelSelectors(combos);
  if (availableCombos.length > 1) {
    throw new Error(
      `第 ${day.day} 天酒店名称选择器数量异常：期望 1，实际 ${availableCombos.length}；` +
        "多个可用 combobox 可能误选，请人工核对后回填",
    );
  }
  if (availableCombos.length === 1) {
    await availableCombos[0].click();
    await delay(300);
    const tierKeyword = operations.hotelTier && /4钻/.test(operations.hotelTier)
      ? "当地4钻酒店/-4"
      : "当地3钻酒店/-3";
    await selectVisibleOption(page, tierKeyword);
  } else {
    // 真实 VBK 渲染：选择「使用携程平台酒店」之后可能尚未生成酒店名称 combobox
    // （或刚生成的瞬间被异步重渲染吃掉）。此时跳过钻级下拉选择，把酒店钻级信息
    // 落到补充说明，交由后续 ensureHotelResource 在资源配置阶段补全酒店资源。
    logWarn(
      `[fillHotelCard] 第 ${day.day} 天酒店名称选择器缺失；跳过钻级下拉选择，补充说明由后续 hotelResource 处理`,
    );
  }
  const supplement = hotelCard.locator('textarea[placeholder="请输入补充说明"]');
  if (await supplement.count()) {
    await supplement.first().fill(day.hotelDescription || day.hotel || `依据产品配置：${operations.hotelTier}`);
  }
}
