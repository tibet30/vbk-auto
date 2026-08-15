// @ts-nocheck
/**
 * ctrip 阶段共用工具集（最初和 phase handler 一起写在 automation/ctrip.ts，后拆出）：
 *   - delay / escapeRegExp / pollUntil / assertCount 通用辅助；
 *   - pickSearchInput / selectVisibleOption / safeClick / fillById / fillVisibleInputs
 *     表单与下拉常用封装；
 *   - 模块整体导出统一走 `export { ... }`，避免给内部函数加 export 暴露给外部。
 *
 * 源码头部带 `// @ts-nocheck`，因为 helper 接收的 locator 类型是松散接住的。
 */


/**
 * 简易异步 sleep：把 setTimeout 包成 Promise，参数 milliseconds。
 */
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

/**
 * 把任意字符串中的正则元字符转义，便于动态拼正则。
 */
const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * 返回真正可写入的搜索控件：直接传入 input / textarea / contenteditable 时返回自身；
 * 传入 Ant combobox 外层时，仅从其内部挑出唯一可见、可编辑的输入控件。
 */
async function pickSearchInput(locator, description) {
  const count = await locator.count();
  if (count !== 1) throw new Error(`${description}搜索输入框数量异常：期望 1，实际 ${count}`);
  const isDirectInput = await locator.evaluate((element) => {
    const tag = element.tagName.toLowerCase();
    return tag === "input" || tag === "textarea" || element.getAttribute("contenteditable") === "true";
  });
  const preferredInput = locator.locator(
    'input.ant-select-search__field:visible:not([disabled]):not([readonly])',
  );
  // Ant 的真实搜索框优先于同一 combobox 内的其它可编辑控件（例如隐藏的旧值输入）。
  // 只有没有任何优先匹配时，才退回通用控件；多个优先匹配仍应明确报歧义。
  const input = isDirectInput
    ? locator
    : (await preferredInput.count()) > 0
      ? preferredInput
      : locator.locator(
        'input:visible:not([disabled]):not([readonly]), ' +
        'textarea:visible:not([disabled]):not([readonly]), [contenteditable="true"]:visible',
      );
  const inputCount = await input.count();
  if (inputCount !== 1) {
    throw new Error(`${description}搜索输入框数量异常：期望 1 个可编辑输入框，实际 ${inputCount}`);
  }
  await input.waitFor({ state: "visible", timeout: 5_000 });
  if (!(await input.isEditable())) throw new Error(`${description}搜索输入框不可编辑`);
  return input;
}

/**
 * 轮询 predicate 直到返回 truthy 或超过 timeoutMs（默认 3s）：
 *   - 每次间隔 150ms 调一次 predicate；
 *   - predicate 抛错视为 false；
 *   - 超时后最后一次再调一次，避免刚好卡时间窗。
 */
async function pollUntil(locator, predicate, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let result = false;
    try {
      result = await predicate(locator);
    } catch {
      result = false;
    }
    if (result) return true;
    await delay(150);
  }
  return predicate(locator).catch(() => false);
}

/**
 * 断言 locator 数量 == expected，否则抛错；
 * 当 expected > 0 时还会等第一个匹配可见（最多 5s），用于在 phase 之间做前置检查。
 */
async function assertCount(locator, expected, description) {
  const count = await locator.count();
  if (count !== expected) {
    throw new Error(`${description}数量异常：期望 ${expected}，实际 ${count}`);
  }
  if (expected > 0) {
    try {
      await locator.first().waitFor({ state: "visible", timeout: 5_000 });
    } catch (error) {
      throw new Error(`${description}可见性等待超时：${(error as Error).message}`);
    }
  }
  return locator;
}

/**
 * 一次 page.evaluateAll 读取动态列表，避免「先 count、再逐个 nth」期间 React
 * 替换节点后，Playwright 对已经不存在的索引自动等待 30 秒。
 */
async function readLocatorSnapshot(locator) {
  return locator.evaluateAll((elements) => elements.map((element) => {
    const html = element;
    const nameNode = html.querySelector?.(".Name[title]");
    return {
      text: String(html.innerText || html.textContent || "").trim(),
      title: String(html.getAttribute?.("title") || "").trim(),
      nameTitle: String(nameNode?.getAttribute?.("title") || "").trim(),
      className: String(html.getAttribute?.("class") || ""),
      value: String(html.getAttribute?.("data-value") || ""),
      id: String(html.getAttribute?.("data-id") || ""),
      ariaSelected: html.getAttribute?.("aria-selected") === "true",
      ariaDisabled: html.getAttribute?.("aria-disabled") === "true",
    };
  }));
}

/**
 * 只返回当前 combobox 通过 aria-controls 绑定的下拉候选。页面可能同时残留
 * 多个“未隐藏”弹层；全局查询会把上一步产品线候选误当成下一步省份候选。
 */
async function getControlledDropdownOptions(page, combobox) {
  const controlId = String(await combobox.getAttribute("aria-controls") || "").trim();
  if (!controlId) throw new Error("下拉框缺少 aria-controls，无法确认候选归属。");
  const escaped = controlId.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return page.locator(`[id="${escaped}"]`).locator(
    '[role="option"], .ant-select-item-option, .ant-select-dropdown-menu-item',
  );
}

/**
 * 对 readLocatorSnapshot 产出的候选做“重新找同一身份 + 原生 click”。读取、
 * 重定位和点击都在一次 evaluateAll 内完成，不触发 Playwright 30 秒 actionability
 * 等待。Ant v3 的远程 Select 会在 mousedown 阶段提交候选，所以这里派发一组
 * 完整鼠标事件，而不是只调用 HTMLElement.click()。
 */
async function clickLocatorSnapshotOption(locator, expected) {
  if (!expected) return false;
  return locator.evaluateAll((elements, wanted) => {
    const wantedIdentity = wanted.value || wanted.id || wanted.nameTitle || wanted.title || wanted.text;
    const match = elements.find((element) => {
      const nameNode = element.querySelector?.(".Name[title]");
      const value = String(element.getAttribute?.("data-value") || "");
      const id = String(element.getAttribute?.("data-id") || "");
      const nameTitle = String(nameNode?.getAttribute?.("title") || "").trim();
      const title = String(element.getAttribute?.("title") || "").trim();
      const text = String(element.innerText || element.textContent || "").trim();
      const identity = value || id || nameTitle || title || text;
      return identity === wantedIdentity;
    });
    if (!match) return false;
    const className = String(match.getAttribute?.("class") || "");
    if (/ant-select-item-disabled|ant-select-dropdown-menu-item-disabled/.test(className)) return false;
    if (match.getAttribute?.("aria-disabled") === "true") return false;
    const view = match.ownerDocument?.defaultView;
    if (!view) return false;
    if (typeof view.PointerEvent === "function") {
      match.dispatchEvent(new view.PointerEvent("pointerdown", {
        bubbles: true, cancelable: true, view, pointerId: 1, pointerType: "mouse",
        isPrimary: true, button: 0, buttons: 1,
      }));
    }
    match.dispatchEvent(new view.MouseEvent("mousedown", {
      bubbles: true, cancelable: true, view, button: 0, buttons: 1,
    }));
    if (typeof view.PointerEvent === "function") {
      match.dispatchEvent(new view.PointerEvent("pointerup", {
        bubbles: true, cancelable: true, view, pointerId: 1, pointerType: "mouse",
        isPrimary: true, button: 0, buttons: 0,
      }));
    }
    match.dispatchEvent(new view.MouseEvent("mouseup", {
      bubbles: true, cancelable: true, view, button: 0, buttons: 0,
    }));
    match.dispatchEvent(new view.MouseEvent("click", {
      bubbles: true, cancelable: true, view, button: 0, buttons: 0,
    }));
    return true;
  }, expected);
}

/**
 * 在当前打开的下拉里选名为 `label`（精确匹配）的选项，并先 assertCount=1 防止歧义。
 */
async function selectVisibleOption(page, label) {
  const option = page.getByRole("option", { name: label, exact: true });
  await assertCount(option, 1, `选项“${label}”`);
  await option.click();
}

/**
 * 带「一次重试」的 click：第一次失败时尝试关掉阻塞弹窗（closeBlockingDialogs）再点一次。
 */
async function safeClick(page, locator, options = {}) {
  try {
    return await locator.click(options);
  } catch (error) {
    const closed = await closeBlockingDialogs(page).catch(() => false);
    if (closed) return await locator.click(options);
    throw error;
  }
}

/**
 * 按 DOM id 唯一定位输入框并 fill（会断言 locator 数量 = 1）。
 */
async function fillById(page, id, value, description) {
  const locator = page.locator(`[id="${id}"]`);
  await assertCount(locator, 1, description);
  await locator.fill(String(value));
}

/**
 * 把 values 顺序填到 locator 当前可见的输入框里：先把可见子集筛出来再写入；
 * 可见数量不足会抛错，undefined 值会跳过，避免覆盖之前的内容。
 */
async function fillVisibleInputs(locator, values, description) {
  const visible = [];
  for (let index = 0; index < (await locator.count()); index += 1) {
    if (await locator.nth(index).isVisible()) visible.push(locator.nth(index));
  }
  if (visible.length < values.length) {
    throw new Error(`${description}输入框不足：期望 ${values.length}，实际 ${visible.length}`);
  }
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] !== undefined) await visible[index].fill(String(values[index]));
  }
}

export {
  delay,
  escapeRegExp,
  pollUntil,
  assertCount,
  readLocatorSnapshot,
  getControlledDropdownOptions,
  clickLocatorSnapshotOption,
  pickSearchInput,
  selectVisibleOption,
  safeClick,
  fillById,
  fillVisibleInputs,
};
