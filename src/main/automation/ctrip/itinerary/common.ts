// @ts-nocheck
/**
 * 行程描述面板的低层 DOM 帮助函数，被 itinerary/main.ts 与子 card 共同复用：
 *   - dayScopeFor：从当天标题 textarea 反向定位「当天」的根 scope；
 *   - ensureOtherCard / ensureServiceTimeRange：在 day scope 内准备「其他」节点 + 时间段；
 *   - clickExact / clickByCandidates / clickLabelExact：表单 / 下拉里点文本或 label；
 *   - cardsByPrefix：按 `td-day-card--` + 文本前缀过滤出某类 card 的多个匹配；
 *   - ensureCheckboxChecked：勾复选框，但已勾时跳过，避免事件重复触发。
 *
 * 顶部带 `// @ts-nocheck`，DOM 是动态传入。
 */
import { delay, escapeRegExp } from "../utils.js";
import { logWarn } from "../../../../shared/log-timestamp.js";

/**
 * 从「当天标题 textarea」反查「当天」的根 scope（`td-day-item--...`），所有 day 级操作以此为根。
 */
export function dayScopeFor(titleInput) {
  return titleInput.locator(
    'xpath=ancestor::*[contains(@class,"td-day-item--")][1]',
  );
}

/**
 * 在 dayScope 内保证「只有一个其他节点」：
 *   - 多于 1 个时点击最后一个节点的删除按钮 + 弹窗确定（最多 20 * 100ms 等待移除）；
 *   - 没有时通过 `td-add-box` / `td-add-plus-btn` / `td-add-item-btn-new` 打开下拉，选「其他」。
 * afterFirstCard=true 时 addBox 取第 2 个（默认第 1 个），用于首日把「其他」挪到接送节点之后。
 */
export async function ensureOtherCard(page, dayScope, { afterFirstCard = false } = {}) {
  const otherCards = dayScope
    .locator('[class*="td-day-card--"]')
    .filter({ hasText: "其他" });
  while ((await otherCards.count()) > 1) {
    const before = await otherCards.count();
    await otherCards.last().getByText("删除", { exact: true }).click({ force: true });
    await delay(300);
    const confirm = page.getByText("确定", { exact: true });
    for (let index = (await confirm.count()) - 1; index >= 0; index -= 1) {
      if (await confirm.nth(index).isVisible()) {
        await confirm.nth(index).click({ force: true });
        break;
      }
    }
    for (let attempt = 0; attempt < 20 && (await otherCards.count()) >= before; attempt += 1) {
      await delay(100);
    }
  }
  if (await otherCards.count()) return otherCards.first();

  const addBoxes = dayScope.locator('[class*="td-add-box"]');
  const addBox = addBoxes.nth(afterFirstCard ? 1 : 0);
  // 首日的“其他”通常要插到首个卡片之后；该 add-box 可能在长页面视口外。
  // 先滚入视口，避免 plus 点击后菜单节点仍处于不可见布局而被误判为缺失。
  await addBox.scrollIntoViewIfNeeded();
  await addBox.locator('[class*="td-add-plus-btn"]').click();
  await delay(500);
  const menuItem = addBox
    .locator('[class*="td-add-item-btn-new"]')
    .filter({ hasText: "其他" });
  let clicked = false;
  for (let index = 0; index < (await menuItem.count()); index += 1) {
    if (await menuItem.nth(index).isVisible()) {
      await menuItem.nth(index).click();
      clicked = true;
      break;
    }
  }
  if (!clicked) throw new Error('新增菜单已打开，但找不到可点击的“其他”节点');
  await otherCards.first().waitFor({ state: "visible", timeout: 8_000 });
  return otherCards.first();
}

/**
 * 行程「可服务时间段」处理：只在「可服务时间段」label 存在时生效；
 *   - 已有 radio 选中 / 已填时间则跳过；
 *   - 否则用 clickByCandidates 试「全天」快捷按钮；
 *   - 没有「全天」快捷按钮仅打 warning，不阻断流程。
 */
export async function ensureServiceTimeRange(dayScope, day) {
  const label = dayScope.getByText("可服务时间段", { exact: true });
  if (!(await label.count())) return;
  const formItem = label.locator("xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' ant-form-item ')][1]");
  if (!(await formItem.count())) return;
  const checkedRadios = formItem.locator("span.ant-radio-checked");
  const isChecked = (await checkedRadios.count()) > 0;
  const timeInputs = formItem.locator("input.ant-time-picker-input");
  const timeCount = await timeInputs.count();
  const timeValues = [];
  for (let index = 0; index < timeCount; index += 1) {
    const val = await timeInputs.nth(index).getAttribute("value");
    timeValues.push((val || "").trim());
  }
  const allTimeEmpty = !timeValues.length || timeValues.every((item) => item.length === 0);
  if (isChecked || !allTimeEmpty) return;
  const setAllDay = await clickByCandidates(formItem, ["全天"], `第 ${day.day} 天可服务时间段`);
  if (!setAllDay) {
    logWarn(`[ensureServiceTimeRange] 第 ${day.day} 天可服务时间段未命中"全天"选项，暂不处理`);
  }
}

/**
 * 在 scope 内点击第一个「可见 + 未选中」的精确文本匹配；全部不可用抛错。
 */
export async function clickExact(scope, label, description = label) {
  const matches = scope.getByText(label, { exact: true });
  const count = await matches.count();
  for (let index = 0; index < count; index += 1) {
    const match = matches.nth(index);
    if (!(await match.isVisible().catch(() => false))) continue;
    if ((await match.getAttribute("aria-selected").catch(() => null)) === "true") return;
    await match.click({ force: true });
    return;
  }
  throw new Error(`找不到可点击的${description}`);
}

/**
 * 在 scope 内按 labels 顺序遍历：先 exact 文本，再空格容忍的正则宽松匹配，
 * 第一个可见匹配就点击并 return true；都不命中返回 false。
 */
export async function clickByCandidates(scope, labels, description = "候选项") {
  const candidates = Array.isArray(labels) ? labels : [labels];
  for (const label of candidates) {
    const exact = scope.getByText(label, { exact: true });
    for (let index = 0; index < (await exact.count()); index += 1) {
      const match = exact.nth(index);
      if (!(await match.isVisible().catch(() => false))) continue;
      await match.click({ force: true });
      return true;
    }
    const loosePattern = new RegExp(escapeRegExp(label).replace(/\\s+/g, "\\\\s*"));
    const looseMatches = scope.getByText(loosePattern);
    for (let index = 0; index < (await looseMatches.count()); index += 1) {
      const match = looseMatches.nth(index);
      if (!(await match.isVisible().catch(() => false))) continue;
      await match.click({ force: true });
      return true;
    }
  }
  return false;
}

/**
 * 在 dayScope 内按「文本以 prefix 开头」找出所有 card（剔除列表头 / 列表体 / 添加按钮等辅助节点）。
 * 返回 BaseLocator 数组，便于后续链式操作。
 */
export async function cardsByPrefix(dayScope, prefix) {
  const base = dayScope.locator('[class*="td-day-card--"]');
  const all = await base.all();
  const indices: number[] = [];
  for (let i = 0; i < all.length; i += 1) {
    const handle = all[i];
    const cls = (await handle.getAttribute("class")) || "";
    if (/td-day-card-(list|hd|bd|additembtn)/.test(cls)) continue;
    const text = (await handle.textContent())?.trim() || "";
    if (text.startsWith(prefix)) indices.push(i);
  }
  return indices.map((idx) => base.nth(idx));
}

/**
 * 点击「label 文本严格等于 label」的 ant-label；visible 且文本严格匹配才点，找不到抛错。
 */
export async function clickLabelExact(scope, label, description = label) {
  const labels = scope.locator("label").filter({ hasText: label });
  for (let index = 0; index < (await labels.count()); index += 1) {
    const text = (await labels.nth(index).allTextContents()).join("").trim();
    if (text === label && (await labels.nth(index).isVisible())) {
      await labels.nth(index).click({ force: true });
      return;
    }
  }
  throw new Error(`找不到${description}标签`);
}

/**
 * 给定复选框 / 父级 ant-checkbox-wrapper，已勾选时跳过；未勾选时 force click。
 * 用 parentClass.includes("ant-checkbox-checked") 判定当前选中状态。
 */
export async function ensureCheckboxChecked(checkbox) {
  const wrapper = checkbox.locator(
    "xpath=ancestor::label[contains(@class,'ant-checkbox-wrapper')][1]",
  );
  const stateNode = (await wrapper.count()) ? wrapper : checkbox.locator("xpath=..");
  const stateClass = (await stateNode.getAttribute("class")) ?? "";
  if (stateClass.includes("ant-checkbox-checked")) return;
  // VBK 的受控 checkbox 需要通过 label/wrapper 触发 React onChange；直接点隐藏
  // input 有时不会更新 wrapper class，保存时会再次报“请选择集合方式”。
  await stateNode.click({ force: true });
}
