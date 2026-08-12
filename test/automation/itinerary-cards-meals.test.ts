import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cardsPath = path.join(
  __dirname,
  "../../src/main/automation/ctrip/itinerary/cards.ts",
);

test("餐饮卡固定为一小时、三餐不含餐，并按早餐房间口径填写说明", async () => {
  const source = await fs.readFile(cardsPath, "utf8");

  assert.match(source, /clickExact\(card, "1小时", `第 \$\{day\.day\} 天\$\{types\[index\]\}用餐时间`\)/);
  assert.doesNotMatch(source, /clickExact\(card, "不限"/);
  assert.match(source, /card\.getByText\("不含餐", \{ exact: true \}\)/);
  assert.match(source, /assertCount\(noMeal, 2, `第 \$\{day\.day\} 天\$\{types\[index\]\}不含餐选项`\)/);
  assert.match(source, /早餐以房间是否含餐为准/);
  assert.match(source, /午餐自理/);
  assert.match(source, /晚餐自理/);
});

test("餐饮卡按早餐、午餐、晚餐顺序处理", async () => {
  const source = await fs.readFile(cardsPath, "utf8");
  assert.match(source, /const types = \["早餐", "午餐", "晚餐"\]/);
  assert.match(source, /"早餐以房间是否含餐为准"/);
  assert.match(source, /"午餐自理"/);
  assert.match(source, /"晚餐自理"/);
});
