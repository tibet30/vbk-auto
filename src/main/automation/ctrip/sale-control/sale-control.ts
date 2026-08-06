// @ts-nocheck
// 销售控制页（saleControlMerge）：新建草稿的产品壳配置。
// 包括 1. 产品类型 / 2. 产品形态 / 3. 是否拆团 / 4. 线路品牌 / 5. 分销渠道
// / 6. 点击下一步并返回携程产品 ID。
import { URLS } from "../../constants.js";
import {
  PRODUCT_TYPE_LABELS,
  PRODUCT_FORM_LABELS,
} from "../../constants.js";
import { assertCount } from "../utils.js";
import {
  findRowByTitle,
  waitForRowEnabledSelect,
  setEnabledSelectByLabel,
  setSplitGroupIfPresent,
  selectLineBrandFirstOption,
  checkAllEnabledDistributionChannels,
} from "./sale-control.controls.js";
import {
  createProductShell,
  waitForPrimaryNextButton,
} from "./sale-control.workflow.js";

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
 *      跟团游额外出现「是否拆团」单选 radio；若被合同锁定则跳过。
 *   3. 线路品牌：单选下拉，默认尊重预选项；为空时选第一项。
 *   4. 分销渠道：一行 checkbox group（不是多选下拉），把所有 enabled 且未选
 *      的渠道全部勾上；disabled 的（如「携程门店」「携程系分销」）不动。
 *   5. 点「下一步」并等待携程跳转到 baseInfoMerge 等产品详情页，返回产品 ID。
 */
async function configureProductShell(page, product) {
  const productType = product?.sales?.productType === "domesticLong"
    ? "domesticLong"
    : "domesticShort";
  const productForm = product?.sales?.productForm === "groupTour"
    ? "groupTour"
    : "privateTour";
  const splitGroup = product?.sales?.splitGroup === true;

  await page.goto(URLS.createSetup, { waitUntil: "domcontentloaded" });
  const nextButton = page.getByRole("button", { name: "下一步", exact: true });
  await waitForPrimaryNextButton(page, nextButton, 30_000);

  await findRowByTitle(page, "分销渠道").waitFor({ state: "visible", timeout: 15_000 });

  // 1) 产品类型
  const productTypeRow = findRowByTitle(page, "产品类型");
  await setEnabledSelectByLabel(page, productTypeRow, PRODUCT_TYPE_LABELS[productType], "产品类型");

  // 2) 产品形态
  const productFormRow = findRowByTitle(page, "产品形态");
  const productFormUnlocked = await waitForRowEnabledSelect(page, productFormRow, 5_000);
  if (productFormUnlocked) {
    await setEnabledSelectByLabel(page, productFormRow, PRODUCT_FORM_LABELS[productForm], "产品形态");
  } else {
    console.warn("[configureProductShell] 产品形态下拉始终 disabled（合同锁定）");
  }

  // 跟团游额外出现「是否拆团」radio
  if (productForm === "groupTour") {
    await setSplitGroupIfPresent(page, splitGroup);
  }

  // 3) 线路品牌
  await selectLineBrandFirstOption(page);

  // 4) 分销渠道
  await checkAllEnabledDistributionChannels(page);

  // 5) 点「下一步」并等跳转，返回携程产品 ID
  return await createProductShell(page);
}

export {
  inspectProductList,
  configureProductShell,
  createProductShell,
};
