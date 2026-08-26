// @ts-nocheck
// 销售控制页（saleControlMerge）：新建草稿的产品壳配置。
// 包括 1. 产品类型 / 2. 产品形态 / 3. 是否拆团 / 4. 线路品牌 / 5. 分销渠道
// / 6. 点击下一步并返回携程产品 ID。
import { logWarn } from "../../../../shared/log-timestamp.js";
import { URLS } from "../../constants.js";
import {
  PRODUCT_TYPE_LABELS,
  PRODUCT_FORM_LABELS,
} from "../../constants.js";
import { assertCount } from "../utils.js";
import {
  findRowByTitle,
  readSmallGroupState,
  waitForRowEnabledSelect,
  setEnabledSelectByLabel,
  setSmallGroupIfPresent,
  selectLineBrandFirstOption,
  smallGroupStateMatches,
  checkAllEnabledDistributionChannels,
} from "./sale-control.controls.js";
import {
  createProductShell,
  waitForPrimaryNextButton,
} from "./sale-control.workflow.js";
import { isProductForm, supportsSmallGroupSettings } from "../../../../shared/product-form.js";

/**
 * 探查产品列表页状态：是否存在「新增产品」按钮、可见行数、当前 URL 与页面 title。
 * 用于初次登入页后的可用性检查（assertCount 检查新增按钮唯一）。
 */
async function inspectProductList(page) {
  const addButton = page.locator("a.clego-order-btn").filter({
    hasText: "新增产品",
  });
  await assertCount(addButton, 1, "新增产品入口");

  const rows = page.locator("table tbody tr");
  return {
    url: page.url(),
    title: await page.title(),
    visibleRows: await rows.count(),
    addProductAvailable: await addButton.isVisible(),
  };
}

/**
 * 销售控制（saleControlMerge）页面：开新草稿时的壳子配置。
 *
 * 完整流程（与原 createProductShell 合并，原子化）：
 *   1. 产品类型（默认「境内短途旅游」）：单选下拉，按 product.sales.productType 选择；
 *      若合同锁住（ant-select-disabled）则跳过，由合同决定。
 *   2. 产品形态（默认「私家团」）：单选下拉，按 product.sales.productForm 选择；
 *      跟团游 / 半自助额外依次配置拼小团、广场拼团和最大拼团人数。
 *   3. 线路品牌：单选下拉，默认尊重预选项；为空时选第一项。
 *   4. 分销渠道：一行 checkbox group（不是多选下拉），把所有 enabled 且未选
 *      的渠道全部勾上；disabled 的（如「携程门店」「携程系分销」）不动。
 *   5. 点「下一步」并等待携程跳转到 baseInfoMerge 等产品详情页，返回产品 ID。
 */
async function configureProductShell(page, product) {
  const productType = product?.sales?.productType === "domesticLong"
    ? "domesticLong"
    : "domesticShort";
  const requestedForm = product?.sales?.productForm;
  const productForm = isProductForm(requestedForm) ? requestedForm : "privateTour";

  await page.goto(URLS.createSetup, { waitUntil: "domcontentloaded" });
  const nextButton = page.getByRole("button", { name: "下一步", exact: true });
  await waitForPrimaryNextButton(page, nextButton, 30_000);

  await findRowByTitle(page, "分销渠道").waitFor({ state: "visible", timeout: 15_000 });

  // 1) 产品类型
  const productTypeRow = findRowByTitle(page, "产品类型");
  const productTypeResult = await setEnabledSelectByLabel(page, productTypeRow, PRODUCT_TYPE_LABELS[productType], "产品类型");
  if (!productTypeResult?.selected) {
    throw new Error(`产品类型未确认选中「${PRODUCT_TYPE_LABELS[productType]}」，已停止选择产品形态。`);
  }

  // 2) 产品形态
  const productFormRow = findRowByTitle(page, "产品形态");
  const productFormUnlocked = await waitForRowEnabledSelect(page, productFormRow, 5_000);
  if (productFormUnlocked) {
    const productFormResult = await setEnabledSelectByLabel(page, productFormRow, PRODUCT_FORM_LABELS[productForm], "产品形态");
    if (!productFormResult?.selected) {
      throw new Error(`产品形态未确认选中「${PRODUCT_FORM_LABELS[productForm]}」。`);
    }
  } else {
    logWarn("[configureProductShell] 产品形态下拉始终 disabled（合同锁定）");
  }

  // 跟团游 / 半自助统一配置拼小团链路；私家团 / 自由行不触碰这些控件。
  if (supportsSmallGroupSettings(productForm)) {
    const smallGroupResult = await setSmallGroupIfPresent(page, {
      wantSplit: true,
      joinSquareGroup: true,
      maxGroupSize: 8,
    });
    if (smallGroupResult?.skipped) {
      throw new Error(`拼小团配置未完成：${smallGroupResult.skipped}。`);
    }
  }

  // 3) 线路品牌
  await selectLineBrandFirstOption(page);

  // 4) 分销渠道
  await checkAllEnabledDistributionChannels(page);

  // 5) 点「下一步」并等跳转，返回携程产品 ID
  const productId = await createProductShell(page);
  if (supportsSmallGroupSettings(productForm)) {
    await persistSmallGroupAfterCreation(page, productId, product?.sales?.maxGroupSize ?? 8);
  }
  return productId;
}

async function persistSmallGroupAfterCreation(page, productId, maxGroupSize) {
  const requestedMaxGroupSize = Math.min(Math.max(Number(maxGroupSize) || 8, 1), 9);
  const saleControlUrl = `https://vbooking.ctrip.com/ivbk/vendor/saleControlMerge?productid=${encodeURIComponent(productId)}&from=vbk`;
  await page.goto(saleControlUrl, {
    waitUntil: "domcontentloaded",
  });
  await findRowByTitle(page, "分销渠道").waitFor({ state: "visible", timeout: 15_000 });
  const result = await setSmallGroupIfPresent(page, {
    wantSplit: true,
    joinSquareGroup: true,
    maxGroupSize: requestedMaxGroupSize,
  });
  if (result?.skipped) throw new Error(`产品创建后拼小团配置未确认：${result.skipped}。`);

  const responsePromise = page.waitForResponse(
    (response) => response.url().includes("/saveSaleControlInfo") && response.request().method() === "POST",
    { timeout: 15_000 },
  );
  page.once("dialog", (dialog) => dialog.accept().catch(() => {}));
  await page.getByRole("button", { name: "保存", exact: true }).click();
  const response = await responsePromise;
  const payload = await response.json().catch(() => ({}));
  const errors = Array.isArray(payload?.ResponseStatus?.Errors) ? payload.ResponseStatus.Errors : [];
  const ack = String(payload?.ResponseStatus?.Ack ?? "");
  if (!response.ok() || (ack !== "Success" && !(ack === "Warning" && isOnlyNonStructuredPoiChannelWarning(errors)))) {
    throw new Error(`产品创建后拼小团配置保存失败：${JSON.stringify(errors || payload).slice(0, 500)}`);
  }
  const requestBody = response.request().postDataJSON?.() ?? {};
  const submitted = requestBody?.saleControlInfoDto ?? {};
  if (submitted.joinPurchasePlaza !== "T"
    || Number(submitted.maxSmallGroupSize) !== requestedMaxGroupSize) {
    throw new Error(`产品创建后拼小团保存请求不完整：${JSON.stringify({
      joinPurchasePlaza: submitted.joinPurchasePlaza,
      maxSmallGroupSize: submitted.maxSmallGroupSize,
    })}`);
  }

  // saleControlMerge 没有独立的读取 API；重新导航会由服务端状态重新渲染表单。
  // 只有请求 DTO 与重载后的远端表单同时一致，才把 Warning/Success 视为已落库。
  await page.goto(saleControlUrl, { waitUntil: "domcontentloaded" });
  await findRowByTitle(page, "分销渠道").waitFor({ state: "visible", timeout: 15_000 });
  const savedState = await readSmallGroupState(page);
  if (!smallGroupStateMatches(savedState, requestedMaxGroupSize)) {
    throw new Error(`产品创建后拼小团配置回读不一致：${JSON.stringify(savedState)}`);
  }
  await page.goto(`https://vbooking.ctrip.com/ivbk/vendor/baseInfoMerge?productid=${encodeURIComponent(productId)}&from=vbk`, {
    waitUntil: "domcontentloaded",
  });
  await page.getByText("基本信息", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
}

function isOnlyNonStructuredPoiChannelWarning(errors) {
  if (!Array.isArray(errors) || errors.length === 0) return false;
  return errors.every((error) => /^产品id:\s*\d+\s+Ctrip售卖产品中景点、购物点、酒店不可有非结构化poi，请在行程中修改后再添加Ctrip渠道$/.test(
    String(error?.Message ?? "").trim(),
  ));
}

export {
  inspectProductList,
  configureProductShell,
  createProductShell,
  isOnlyNonStructuredPoiChannelWarning,
};
