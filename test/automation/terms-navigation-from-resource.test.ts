import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("结构化条款由产品 ID 直达 API，不依赖资源页或条款页导航", async () => {
  const source = await readFile(
    new URL("../../src/main/automation/ctrip/tabs.ts", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("async function clickSection(");
  const end = source.indexOf("async function waitForSectionEnabled", start);
  const body = source.slice(start, end);
  assert.match(body, /packageManage\|priceInventory\|newResourceRule/);

  const pricing = await readFile(
    new URL("../../src/main/automation/ctrip/pricing.ts", import.meta.url),
    "utf8",
  );
  assert.match(pricing, /saveStructuredProductClauses/);
  const pricingStart = pricing.indexOf("export async function fillAndSaveTerms");
  const pricingBody = pricing.slice(pricingStart, pricing.indexOf("\n}\n\nexport {", pricingStart));
  assert.doesNotMatch(pricingBody, /page\.goto|newResourceClause/);
});
