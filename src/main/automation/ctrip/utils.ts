// @ts-nocheck
// Utility helpers shared across ctrip phases.
// Originally lived alongside phase handlers in automation/ctrip.ts; now its own module.

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function pickSearchInput(locator, description) {
  const count = locator.count();
  if (count !== 1) throw new Error(`${description}搜索输入框数量异常：期望 1，实际 ${count}`);
  return locator;
}

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

async function selectVisibleOption(page, label) {
  const option = page.getByRole("option", { name: label, exact: true });
  await assertCount(option, 1, `选项“${label}”`);
  await option.click();
}

async function safeClick(page, locator, options = {}) {
  try {
    return await locator.click(options);
  } catch (error) {
    const closed = await closeBlockingDialogs(page).catch(() => false);
    if (closed) return await locator.click(options);
    throw error;
  }
}

async function fillById(page, id, value, description) {
  const locator = page.locator(`[id="${id}"]`);
  await assertCount(locator, 1, description);
  await locator.fill(String(value));
}

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
  pickSearchInput,
  selectVisibleOption,
  safeClick,
  fillById,
  fillVisibleInputs,
};
