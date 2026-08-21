// @ts-nocheck
/**
 * 销售控制（sale-control）相关流程级 helper：
 *   - waitForProductIdFromUrl 轮询 URL 拿 productId，并确认已经落到产品信息详情页；
 *   - pickVisiblePrimaryNextButton / pickFallbackNextButton 用「骨架屏内部按钮 / disabled
 *     按钮」等多条件过滤，挑出真正可点的「下一步」；
 *   - waitForPrimaryNextButton 在超时前同时尝试 primary 与 fallback；
 *   - createProductShell 串联上面所有：点下一步 → 等 productId → 返回。
 *
 * 顶部带 `// @ts-nocheck`，参数 page / locator 是动态传入。
 */

import { delay } from "../utils.js";

/**
 * 等 page URL 真正落到产品信息详情页（baseInfoMerge）后从 searchParams 中解析
 * productId。销售控制保存后可能短暂停留在 saleControlMerge?productId=...，这不是
 * 产品信息已打开的证据，不能在此处提前让上层推进 basic。轮询 30s 后仍找不到返回
 * null（让上层决定抛错）。
 */
async function waitForProductIdFromUrl(page, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const productId = (() => {
      try {
        const currentUrl = page.url();
        if (typeof currentUrl !== "string" || currentUrl.length === 0) return null;
        const current = new URL(currentUrl);
        // 只接受产品信息详情页。saleControlMerge 在保存后可能先带上
        // productId，再异步跳转；此时必须继续等待，保持 saleControl running。
        if (!/\/ivbk\/vendor\/baseInfoMerge$/.test(current.pathname)) return null;
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

/**
 * 挑第一个「可见、不 disabled、不在 #lingjie-skeleton 骨架屏里」的「下一步」按钮。
 * 用于 saleControlMerge 等页面有多个同名按钮时选中真正可点的主操作按钮。
 */
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

/**
 * 轮询直到任一「下一步」按钮（primary 或 fallback）可见且 enabled；超时抛错。
 * 传 locator 是兜底用，实际先用 pickVisiblePrimaryNextButton 试主按钮。
 */
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

/**
 * 从传入 locator 里挑第一个「可见 + enabled」的「下一步」按钮；用于当所有候选都被判定为
 * 骨架屏内部 / disabled 时的兜底选择。
 */
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

/**
 * 点「下一步」创建产品壳：先 pickVisiblePrimaryNextButton，再 fallback；点击后等 URL
 * 落到 baseInfoMerge 并出现 productId；若携程只在 saleControlMerge 原页回填 ID，
 * 仍继续等待真实产品信息详情页，避免 basic 阶段状态领先页面。
 */
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
