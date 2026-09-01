// @test-layer e2e
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { launchVbkBrowser, openAndVerifyList } from "../../src/main/automation/browser.js";
import { configureProductShellApi } from "../../src/main/automation/ctrip/sale-control/api.js";
import { ensureBasicInfoApi } from "../../src/main/automation/ctrip/basic-info/api.js";
import { fillAndSavePresentation } from "../../src/main/automation/ctrip/presentation/presentation.js";
import { fillItineraryDraftApi } from "../../src/main/automation/ctrip/itinerary/api-entry.js";
import { ensurePackageApi } from "../../src/main/automation/ctrip/package-api.js";
import { ensurePricingInventoryApi } from "../../src/main/automation/ctrip/pricing-api.js";
import { fillAndSaveTerms } from "../../src/main/automation/ctrip/terms.js";
import { runProductPreflightApi } from "../../src/main/automation/ctrip/preflight-api.js";
import { parseProduct } from "../../src/main/automation/schema/schema.js";

const enabled = process.env.VBK_LIVE_E2E === "1";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`真实 E2E 缺少 ${name}`);
  return value;
}

async function loadProduct() {
  const file = required("VBK_LIVE_E2E_PRODUCT_FILE");
  const content = await readFile(file, "utf8");
  return parseProduct(JSON.parse(content));
}

function contactSelection() {
  return {
    contactCardId: Number(required("VBK_LIVE_E2E_CONTACT_CARD_ID")),
    displayName: required("VBK_LIVE_E2E_CONTACT_NAME"),
    providerId: Number(required("VBK_LIVE_E2E_PROVIDER_ID")),
  };
}

test("live e2e：创建一款 VBK 草稿并完成 API 录入与远端 preflight", { skip: !enabled, timeout: 300_000 }, async () => {
  const product = await loadProduct();
  const contact = contactSelection();
  assert.ok(Number.isInteger(contact.contactCardId) && contact.contactCardId > 0, "联系人卡 ID 必须为正整数");
  assert.ok(Number.isInteger(contact.providerId) && contact.providerId > 0, "供应商 ID 必须为正整数");

  const { context, page } = await launchVbkBrowser({ headless: process.env.VBK_LIVE_E2E_HEADLESS === "1" });
  let productId = "";
  try {
    await openAndVerifyList(page);
    productId = await configureProductShellApi(page, product);
    const basic = await ensureBasicInfoApi(
      page,
      product,
      productId,
      contact,
      required("VBK_LIVE_E2E_SERVICE_PHONE"),
    );
    const presentation = await fillAndSavePresentation(page, product, productId);
    const itinerary = await fillItineraryDraftApi(page, product, { productId });
    const packageResult = await ensurePackageApi(page, product, productId);
    const pricingInventory = await ensurePricingInventoryApi(page, product, productId);
    const terms = await fillAndSaveTerms(page, product, productId);
    const preflight = await runProductPreflightApi(page, product, productId);

    assert.equal(basic.productId, productId);
    assert.equal(presentation.productId, Number(productId));
    assert.equal(itinerary.days, product.itinerary.length);
    assert.equal(packageResult.verified, true);
    assert.equal(pricingInventory.verified, true);
    assert.ok(terms);
    assert.equal(preflight.verifiedWith, "remote-api-readback");
    assert.equal(preflight.productId, productId);
    console.log(`[live-e2e] 草稿已保存并完成远端回读：productId=${productId}`);
  } finally {
    await context.close();
  }
});
