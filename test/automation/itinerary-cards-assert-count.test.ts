// 锁死 itinerary/cards.ts 中 assertCount 的真实运行时来源：
//   - 必须从 ../utils.js 真实导入（utils.ts 里有 async function assertCount 并 export）；
//   - 不得退化为 `declare function assertCount(...)` 占位（仅类型声明，运行时会抛
//     `ReferenceError: assertCount is not defined`，破坏 fillMealCards 的「费用自理」选项断言）。
// 历史 bug：declare-only 占位会让 `await assertCount(selfPay, 2, ...)` 直接 ReferenceError。
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
const utilsPath = path.join(
  __dirname,
  "../../src/main/automation/ctrip/utils.ts",
);

test("cards.ts：assertCount 必须从 ../utils.js 真实导入", async () => {
  const src = await fs.readFile(cardsPath, "utf8");

  // 1) 既有 import 形态必须包含 assertCount（与 delay / selectVisibleOption 同列）
  const importLine = src
    .split("\n")
    .find((line) => /from\s+"\.\.\/utils\.js"/.test(line));
  assert.ok(importLine, "cards.ts 必须存在 `from \"../utils.js\"` 的导入语句");
  assert.match(
    importLine!,
    /import\s*\{[^}]*\bassertCount\b[^}]*\}\s*from\s*"\.\.\/utils\.js"/,
    `assertCount 必须从 ../utils.js 真实导入，当前行：${importLine}`,
  );

  // 2) 严禁任何 declare 占位声明（function / var / const / let）—— 在 .ts-nocheck 下
  // 编译为 JS 后不会生成任何运行时实现，运行期直接 ReferenceError。
  assert.doesNotMatch(
    src,
    /^\s*declare\s+(?:function|var|const|let)\s+assertCount\b/m,
    "cards.ts 不得再使用 declare 占位声明 assertCount；" +
      "该声明在运行时不存在，会导致 fillMealCards 直接 ReferenceError='assertCount is not defined'",
  );

  // 3) utils.ts 必须确实导出名为 assertCount 的 async function，且签名含 (locator, expected, description)。
  // 防止 utils.ts 被改坏而该测试误判通过。
  const utilsSrc = await fs.readFile(utilsPath, "utf8");
  assert.match(
    utilsSrc,
    /async\s+function\s+assertCount\s*\(\s*locator\s*,\s*expected\s*,\s*description\s*\)/,
    "utils.ts 必须存在 `async function assertCount(locator, expected, description)` 的真实实现",
  );
  assert.match(
    utilsSrc,
    /export\s*\{[^}]*\bassertCount\b[^}]*\}/,
    "utils.ts 必须把 assertCount 列入 export 列表",
  );
});

test("cards.ts：fillMealCards 原 assertCount(selfPay, 2, 描述) 调用保持不变", async () => {
  const src = await fs.readFile(cardsPath, "utf8");
  // 原调用形态：await assertCount(selfPay, 2, `第 ${day.day} 天${types[index]}费用自理选项`)
  // 这里直接按字面量断言（regex 用 \s* 容忍缩进，模板字符串里只有 types[index] 是变量插值）。
  assert.match(
    src,
    /await\s+assertCount\s*\(\s*selfPay\s*,\s*2\s*,\s*`第\s*\$\{day\.day\}\s*天\$\{types\[index\]\}费用自理选项`\s*\)/,
    "fillMealCards 内的 await assertCount(selfPay, 2, `第 ${day.day} 天${types[index]}费用自理选项`) 必须保持不变",
  );
});
