// 锁死 selectStationAddress 索引契约：弹窗只有 2 个 input（airport=0, train=1）
// 任何把 indexes 写为 1/2 的改动必须失败本测试。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ctripPath = path.join(__dirname, "../../src/main/automation/ctrip/ctrip.ts");

test("selectStationAddress 弹窗 input 契约：airport=0, train=1", async () => {
  const src = await fs.readFile(ctripPath, "utf8");
  // 抽取 selectStationAddress 函数体
  const start = src.indexOf("export async function selectStationAddress");
  assert.ok(start >= 0, "找不到 selectStationAddress");
  // 找下一个 `async function fillPickupAndDropoff` 作为函数结尾
  const end = src.indexOf("\nasync function fillPickupAndDropoff", start);
  assert.ok(end > start, "找不到函数结尾");
  const fnBody = src.slice(start, end);

  // 契约 1：inputs 数量校验必须 >= 2（dialog 实际有 2 个：airport + train）
  // 老实现是 throw Error，新实现是 graceful 返回 reason。
  assert.ok(
    /if\s*\(\s*\(await\s+inputs\.count\(\)\)\s*<\s*2\s*\)/.test(fnBody) ||
    /dialogInputCount\s*<\s*2/.test(fnBody),
    "selectStationAddress 必须检测 dialog input 数量",
  );

  // 契约 2：必须用 airport=0, train=1 的索引（不是 1, 2）
  // 老代码里 "inputs 里有隐藏的 <input type='hidden'>，可写输入从下标 1 起"
  // 注释是过时的：现在 dialog 只有 2 个 input，索引必须从 0 起。
  const calls = [...fnBody.matchAll(/fillStationField\(\s*(\d+)\s*,\s*"(airport|train)"\s*\)/g)].map(m => ({
    index: Number(m[1]),
    kind: m[2],
  }));
  // 必须正好两次：一次 airport 一次 train
  const airportCall = calls.find((c) => c.kind === "airport");
  const trainCall = calls.find((c) => c.kind === "train");
  assert.ok(airportCall, "必须有 fillStationField(?, \"airport\") 调用");
  assert.ok(trainCall, "必须有 fillStationField(?, \"train\") 调用");
  assert.equal(airportCall!.index, 0, "airport 索引必须是 0（dialog 第 1 个 input）");
  assert.equal(trainCall!.index, 1, "train 索引必须是 1（dialog 第 2 个 input）");

  // 契约 3：注释里不得再写「下标 1 起」（已被实际 DOM 推翻）
  assert.doesNotMatch(
    fnBody,
    /可写输入从下标\s*1\s*起/,
    "过时注释：dialog 实际只有 2 个 input，索引必须从 0 起",
  );

  // 契约 4：函数体里「点 inputs.nth(2)」这种硬编码越界不允许。
  // 抽取函数体里所有的 inputs.nth(N) 出现位置（跳过 fillStationField 函数定义体里
  // 那个参数化的 inputs.nth(fieldIndex)，因为它会被真实数字索引替换）。
  // 简单方法：只检查 "literal" 数字索引 — 直接看是否有 inputs.nth(2) 出现。
  // fillStationField 内是 inputs.nth(fieldIndex)，fieldIndex 是参数；所以
  // inputs.nth(2) 只可能在外层错误地硬编码。
  assert.doesNotMatch(
    fnBody,
    /inputs\.nth\(\s*2\s*\)/,
    "inputs.nth(2) 已越界（dialog 只有 2 input）。该 bug 早在 0/1 索引断言上就被拦截；此处为冗余检查。",
  );
});
