// 锁死 itinerary/stations.ts 中 safeClick 的真实运行时来源：
//   - 必须从 ../utils.js 真实导入（utils.ts 里有 async function safeClick 并 export）；
//   - 不得退化为 `declare function safeClick(...)` 占位（仅类型声明，运行时会抛
//     `ReferenceError: safeClick is not defined`，破坏 itinerary 重试）。
// 历史 bug：product ee4aefd7-033b-4639-a318-43d5cb51ff64 itinerary 真实重试
// finalError='safeClick is not defined'，根因就是 declare-only 占位。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const stationsPath = path.join(
  __dirname,
  "../../src/main/automation/ctrip/itinerary/stations.ts",
);
const utilsPath = path.join(
  __dirname,
  "../../src/main/automation/ctrip/utils.ts",
);

test("stations.ts：safeClick 必须从 ../utils.js 真实导入", async () => {
  const src = await fs.readFile(stationsPath, "utf8");

  // 1) 既有 import 形态必须包含 safeClick（保留既有命名风格：与 delay / escapeRegExp 同列）
  const importLine = src
    .split("\n")
    .find((line) => /from\s+"\.\.\/utils\.js"/.test(line));
  assert.ok(importLine, "stations.ts 必须存在 `from \"../utils.js\"` 的导入语句");
  assert.match(
    importLine!,
    /import\s*\{[^}]*\bsafeClick\b[^}]*\}\s*from\s*"\.\.\/utils\.js"/,
    `safeClick 必须从 ../utils.js 真实导入，当前行：${importLine}`,
  );

  // 2) 严禁任何 `declare function safeClick(...)` 占位声明 —— 该形式在 .ts-nocheck 下
  // 编译为 JS 后不会生成任何运行时实现，运行期直接 ReferenceError。
  assert.doesNotMatch(
    src,
    /^\s*declare\s+function\s+safeClick\b/m,
    "stations.ts 不得再使用 `declare function safeClick(...)` 占位；" +
      "该声明在运行时不存在，会导致 itinerary 真实重试 finalError='safeClick is not defined'",
  );
  assert.doesNotMatch(
    src,
    /\bdeclare\s+var\s+safeClick\b/,
    "stations.ts 不得再使用 `declare var safeClick` 占位",
  );

  // 3) utils.ts 必须确实导出名为 safeClick 的 async function，且签名含 (page, locator, options?)。
  // 防止 utils.ts 被改坏而该测试误判通过。
  const utilsSrc = await fs.readFile(utilsPath, "utf8");
  assert.match(
    utilsSrc,
    /async\s+function\s+safeClick\s*\(\s*page\s*,\s*locator\s*,\s*options[^)]*\)/,
    "utils.ts 必须存在 `async function safeClick(page, locator, options?)` 的真实实现",
  );
  assert.match(
    utilsSrc,
    /export\s*\{[^}]*\bsafeClick\b[^}]*\}/,
    "utils.ts 必须把 safeClick 列入 export 列表",
  );
});

test("stations.ts：safeClick 的三处既有调用形态保持不变", async () => {
  const src = await fs.readFile(stationsPath, "utf8");

  // 三类既有调用形态（参数个数 / 是否带 options / 是否带 .catch）：
  //   a) safeClick(page, addressInput.first()) — 不带 options
  //   b) safeClick(page, input)                 — 不带 options
  //   c) safeClick(page, confirm, { force: true }).catch(() => false) — 带 options + .catch
  //
  // 这里直接按字面量断言（regex 用 \s* 容忍缩进），避免用平衡括号解析解析
  // .first() 这类嵌套调用。

  // 形态 a：地址输入框（参数含 addressInput.first()）
  assert.match(
    src,
    /safeClick\s*\(\s*page\s*,\s*addressInput\.first\s*\(\s*\)\s*\)/,
    "必须保留 safeClick(page, addressInput.first()) 这一调用",
  );

  // 形态 b：fillStationField 内部 safeClick(page, input)
  assert.match(
    src,
    /safeClick\s*\(\s*page\s*,\s*input\s*\)/,
    "必须保留 safeClick(page, input) 这一调用",
  );

  // 形态 c：confirm 用 { force: true } + .catch(() => false)
  // 必须保留两处：首点 + 弹窗仍可见时的重试
  const forceCatchCount = (src.match(
    /safeClick\s*\(\s*page\s*,\s*confirm\s*,\s*\{\s*force\s*:\s*true\s*\}\s*\)\s*\.catch\(\s*\(\)\s*=>\s*false\s*\)/g,
  ) || []).length;
  assert.equal(
    forceCatchCount,
    2,
    "必须保留两处 safeClick(page, confirm, { force: true }).catch(() => false) " +
      "（首点 + 弹窗仍可见时的重试）",
  );
});

test("首末日全天时间必须普通点击 label，不能 force click 绕过受控 radio", async () => {
  const src = await fs.readFile(stationsPath, "utf8");
  const setAllDay = src.slice(
    src.indexOf("async function setAllDay"),
    src.indexOf("async function fillEmptyStationAddresses"),
  );
  assert.match(setAllDay, /label\.click\(\{ timeout: 2_000 \}\)/);
  assert.doesNotMatch(setAllDay, /label\.click\(\{\s*force\s*:\s*true\s*\}\)/);
});
