// @ts-nocheck
/**
 * 发布与审核阶段（preflight → submitReview → publishProduct → auditPublishedProduct）：
 *   - runProductPreflight 在提交审核前做轻量自检（库存日期 / 私家团用车 ID）并打开产品编辑页；
 *   - submitProductReview 按产品配置决定是否点「提交审核」按钮；
 *   - publishProduct 在产品列表把目标产品从「无效」切到「有效 / 上线」；
 *   - auditPublishedProduct 上线后回 B 端与 C 端页面校验价格、库存、URL 可达性。
 *
 * 注：源码头部带 `// @ts-nocheck`，因为 VBK 页面 DOM 不稳定，类型收益有限。
 */


import { URLS, productSectionUrl, isOnlineStatus, isValidStatus, productEditorUrl } from "../constants.js";
import { fillAndSubmitPricingInventory } from "./pricing.js";
import { ensureCheckboxChecked } from "./itinerary/itinerary.js";

/**
 * 发布前置自检：在进入产品编辑页之前，对 inventory / pricing / 私家团用车配置做轻量校验，
 * 然后跳转到产品编辑页并确认页面文本里包含目标 productId，避免后续阶段对错页面操作。
 */
export async function runProductPreflight(page, product, productId) {
  if (!product.commercial) throw new Error("缺少 commercial 配置");
  if (product.commercial.inventory && product.commercial.pricing) {
    const { startDate, endDate, dailyQuota } = product.commercial.inventory;
    if (new Date(startDate) > new Date(endDate)) throw new Error("库存开始日期晚于结束日期");
    if (dailyQuota < product.commercial.pricing.minimumTravelers) {
      throw new Error("每日库存小于最低成团人数");
    }
  }
  if (product.sales.productForm === "privateTour") {
    const groupId = product.operations?.vehicleResource?.resourceGroupId;
    if (!groupId) throw new Error("私家团未配置现有用车资源组 ID");
  }
  await page.goto(productEditorUrl(productId), { waitUntil: "domcontentloaded" });
  const body = await page.locator("body").innerText();
  if (!body.includes(String(productId))) throw new Error("产品详情页未加载目标产品");
  return { productId: String(productId), commercialData: "ok" };
}

/**
 * 点击「提交审核」按钮；若「数据配置为不提审」或页面无该按钮（说明各模块已在对应阶段提交过）则跳过。
 */
export async function submitProductReview(page, product) {
  if (!product.commercial?.release.submitReview) return { skipped: "数据配置为不提审" };
  const button = page.getByRole("button", { name: "提交审核", exact: true });
  if (!(await button.count())) {
    return { submitted: true, mode: "各模块已在对应阶段提交审核" };
  }
  await button.waitFor({ state: "visible", timeout: 30_000 });
  await button.click();
  await page.waitForTimeout(1500);
  return { submitted: true };
}

/**
 * 在产品列表的 tbody 中找到第一行 productId 文本匹配的行并等待可见。
 */
async function findProductRow(page, productId) {
  const row = page.locator("tbody tr").filter({ hasText: String(productId) });
  await row.first().waitFor({ state: "visible", timeout: 30_000 });
  return row.first();
}

/**
 * 通过 URLS.list 跳到产品列表，切到「全部」，按 productId 查询并返回第一行；
 * 是 findProductRow + 列表导航的封装。
 */
async function queryProductRow(page, productId) {
  await page.goto(URLS.list, { waitUntil: "domcontentloaded" });
  const allTab = page.getByText("全部", { exact: true }).first();
  if (await allTab.count()) await allTab.click();
  const idSearch = page.getByRole("textbox", { name: "多个用英文逗号分隔" });
  await idSearch.fill(String(productId));
  await page.getByRole("button", { name: "查 询" }).click();
  await page.waitForTimeout(700);
  return findProductRow(page, productId);
}

/**
 * 等待一个弹窗出现并校验其文本包含 expectedText（用于「操作成功」「批量上线处理成功」等），
 * 校验通过后点击「知道了」关闭。
 */
async function acknowledgeResult(page, expectedText) {
  const dialog = page.getByRole("dialog").filter({ hasText: expectedText });
  await dialog.waitFor({ state: "visible", timeout: 10_000 });
  const text = await dialog.innerText();
  if (!text.includes(expectedText)) throw new Error(text);
  await dialog.getByRole("button", { name: "知道了" }).click();
}

/**
 * 上线阶段：把产品逐个从「无效」切到「有效/上线」。
 *   - 列表里若「设为有效」则先点；
 *   - 否则勾选 checkbox → 点「批量上线」→ 等成功弹窗；
 *   - 任一步不达有效/上线抛错。
 */
export async function publishProduct(page, product, productId) {
  if (!product.commercial?.release.publishAfterApproval) return { skipped: "数据配置为不上线" };
  let row = await queryProductRow(page, productId);
  const makeValid = row.getByText("设为有效", { exact: true });
  if (await makeValid.count()) {
    await makeValid.click();
    await acknowledgeResult(page, "操作成功");
    row = await queryProductRow(page, productId);
  }

  let status = (await row.innerText()).replace(/\s+/g, " ");
  if (!isOnlineStatus(status)) {
    await ensureCheckboxChecked(row.getByRole("checkbox"));
    await page.getByRole("button", { name: "批量上线" }).click();
    await acknowledgeResult(page, "批量上线处理成功");
    row = await queryProductRow(page, productId);
    status = (await row.innerText()).replace(/\s+/g, " ");
  }
  if (!isValidStatus(status) || !isOnlineStatus(status)) {
    throw new Error(`发布状态未达到“有效/上线”：${status}`);
  }
  return { published: true, status: "有效/上线" };
}

/**
 * 上线后巡检：
 *   - 列表状态必须为有效/上线；
 *   - 进 pricingInventory 校验页面文本包含 product.commercial 里 expected 的价格 / 库存文本；
 *   - 跳到 C 端公开 URL 提取「¥xx 起」价格，确认不超 release.publicPriceCeiling；
 *   - 越界则尝试触发 fillAndSubmitPricingInventory 修复一次，不行再抛错。
 */
export async function auditPublishedProduct(page, product, productId) {
  const row = await queryProductRow(page, productId);
  const status = (await row.innerText()).replace(/\s+/g, " ");
  if (!isValidStatus(status) || !isOnlineStatus(status)) {
    throw new Error(`上线后检查失败：${status}`);
  }
  await page.goto(productSectionUrl(productId, "pricingInventory"), {
    waitUntil: "domcontentloaded",
  });
  const pricingText = (await page.locator("body").innerText()).replace(/\s+/g, " ");
  const cost = product.commercial.pricing.cost;
  const expected = [
    ...(cost?.adult === undefined ? [] : [`${product.commercial.pricing.adult}/${cost.adult}`]),
    ...(cost?.child === undefined ? [] : [`${product.commercial.pricing.child}/${cost.child}`]),
    `0/${product.commercial.inventory.dailyQuota}`,
  ];
  for (const value of expected) {
    if (!pricingText.includes(String(value))) throw new Error(`上线后未核验到价格/库存值：${value}`);
  }

  const publicUrl = `https://vacations.ctrip.com/travel/detail/p${productId}/`;
  const ceiling = product.commercial.release.publicPriceCeiling;
  const retries = product.commercial.release.publicAuditRetries;
  let repaired = false;
  let publicPrices = [];
  let publicText = "";

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    await page.goto(`${publicUrl}?vbkAudit=${Date.now()}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1_200);
    publicText = await page.locator("body").innerText();
    publicPrices = [...publicText.matchAll(/(?:¥|￥)?(\d+)起/g)].map((match) => Number(match[1]));
    const outliers = publicPrices.filter((price) => price > ceiling);
    if (
      publicText.includes(String(productId)) &&
      publicPrices.length > 0 &&
      outliers.length === 0
    ) {
      return {
        productId: String(productId),
        status: "有效/上线",
        priceInventory: "verified",
        publicUrl,
        publicPrices: [...new Set(publicPrices)],
        repaired,
      };
    }
    if (!repaired && outliers.length) {
      await fillAndSubmitPricingInventory(page, product, productId);
      repaired = true;
    }
    await page.waitForTimeout(5_000);
  }
  throw new Error(
    `上线后客端价格检查失败：上限 ${ceiling}，检测价格 ${publicPrices.join("、") || "无"}`,
  );
}

export {
  acknowledgeResult,
  findProductRow,
  queryProductRow,
};