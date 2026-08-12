import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("有产品 ID 时结构化条款走正式接口，旧页面才回退自由文本", async () => {
  const source = await readFile(
    new URL("../../src/main/automation/ctrip/pricing.ts", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("export async function fillAndSaveTerms");
  const end = source.indexOf("\n}\n\nexport {", start);
  const body = source.slice(start, end);
  assert.match(body, /newResourceClause/);
  assert.match(body, /return saveStructuredProductClauses\(page, productId\)/);
  assert.ok(body.indexOf("saveStructuredProductClauses") < body.indexOf("await fillVisibleInputs"));
});

test("结构化条款补齐儿童住宿口径与住宿自理说明", async () => {
  const source = await readFile(
    new URL("../../src/main/automation/ctrip/clauses-api.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /childNoBed:\s*10091/);
  assert.match(source, /otherfeewithout1/);
  assert.match(source, /lodgingSelfPayNote/);
  assert.match(source, /async \(\{ productId, head, requiredIds, lodgingSelfPayNote \}\) =>/);
});
