import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("资源配置页仍保持历史短路，结构化条款由产品 ID 直达接口页", async () => {
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
  assert.match(pricing, /newResourceClause\?productid=/);
  assert.match(pricing, /saveStructuredProductClauses/);
});
