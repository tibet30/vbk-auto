// @ts-nocheck
import { delay } from "../utils.js";

async function waitForProductIdFromUrl(page) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const productId = (() => {
      try {
        const currentUrl = page.url();
        if (typeof currentUrl !== "string" || currentUrl.length === 0) return null;
        if (!/\/_?ivbk\/vendor\//.test(currentUrl) && !/\/_?ivbk\//.test(currentUrl)) return null;
        const current = new URL(currentUrl);
        return current.searchParams.get("productId") || current.searchParams.get("productid");
      } catch {
        return null;
      }
    })();
    if (productId) return productId;
    await delay(200);
  }
  return null;
}

async function pickVisiblePrimaryNextButton(page) {
  const nextButtons = page.getByRole("button", { name: "下一步", exact: true });
  const count = await nextButtons.count();
  const picked = [];

  for (let i = 0; i < count; i += 1) {
    const button = nextButtons.nth(i);
    const visible = await button.isVisible().catch(() => false);
    if (!visible) continue;
    const disabled = await button.isDisabled().catch(() => true);
    if (disabled) continue;
    const inSkeleton = await button.evaluate((node) => Boolean(node.closest("#lingjie-skeleton"))).catch(() => false);
    if (inSkeleton) continue;
    picked.push(button);
  }

  if (picked.length >= 1) return picked[0];
  return null;
}

async function waitForPrimaryNextButton(page, locator, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const button = await pickVisiblePrimaryNextButton(page);
    if (button) {
      const visible = await button.isVisible().catch(() => false);
      const disabled = await button.isDisabled().catch(() => true);
      if (visible && !disabled) return;
    }

    const fallback = await pickFallbackNextButton(locator);
    if (fallback) {
      const visible = await fallback.isVisible().catch(() => false);
      const disabled = await fallback.isDisabled().catch(() => true);
      if (visible && !disabled) return;
    }
    await delay(200);
  }
  throw new Error("下一步按钮未在预期时间内可见");
}

async function pickFallbackNextButton(locator) {
  const count = await locator.count();
  for (let i = 0; i < count; i += 1) {
    const button = locator.nth(i);
    const visible = await button.isVisible().catch(() => false);
    if (!visible) continue;
    const disabled = await button.isDisabled().catch(() => true);
    if (disabled) continue;
    return button;
  }
  return null;
}

async function createProductShell(page) {
  const nextButton = page.getByRole("button", { name: "下一步", exact: true });
  const filteredNextButton = await pickVisiblePrimaryNextButton(page);
  if (filteredNextButton) {
    await filteredNextButton.click();
  } else {
    const fallbackButton = await pickFallbackNextButton(nextButton);
    if (!fallbackButton) {
      throw new Error('找不到可点击的“下一步”按钮');
    }
    await fallbackButton.click();
  }
  const productId = await waitForProductIdFromUrl(page);
  if (!productId) throw new Error("携程已进入详情页，但未返回产品 ID");
  return productId;
}

export {
  createProductShell,
  pickFallbackNextButton,
  pickVisiblePrimaryNextButton,
  waitForPrimaryNextButton,
  waitForProductIdFromUrl,
};
