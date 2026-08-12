// 锁定 fillItineraryDraft 顶层的轮询 + 数量断言契约：
//   - src/main/automation/ctrip/itinerary/main.ts 早期曾把 pollUntilLocal / assertCount
//     写成 `declare function ...` 占位，运行期调用会 ReferenceError；
//   - 修复后必须从 ../utils.js 真实导入 pollUntil / assertCount；
//   - 行为契约：
//       * 标题 textarea 数量延迟满足（count 第一次为 0，~200ms 后变为期望值）时，
//         pollUntil 必须等待并返回 true，且全程不抛 ReferenceError；
//       * 轮询超时仍未满足期望数量时，必须走 assertCount 的「数量异常」错误，
//         而不是「pollUntilLocal is not defined」之类的 undefined 错误。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pollUntil, assertCount } from "../../src/main/automation/ctrip/utils.ts";
import { fillItineraryDraft } from "../../src/main/automation/ctrip/itinerary/main.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mainPath = path.join(__dirname, "../../src/main/automation/ctrip/itinerary/main.ts");

/** 构造一个会模拟「n 次返回 0，之后稳定返回 target」的 count locator。 */
function makeDelayedCountLocator(target: number, delayMs: number) {
  let calls = 0;
  let resolveCount!: (value: number) => void;
  const pending: Promise<number> = new Promise((resolve) => {
    resolveCount = resolve;
  });
  // 首次同步返回 0，后续转到 pending；pending 在 delayMs 后 resolve 为 target。
  setTimeout(() => resolveCount(target), delayMs);
  return {
    count: async () => {
      calls += 1;
      if (calls === 1) return 0;
      return pending;
    },
    calls: () => calls,
  };
}

/** 构造一个永远返回 0 的 count locator。 */
function makeZeroCountLocator() {
  return {
    count: async () => 0,
  };
}

test("main.ts 已修复：从 utils.js 真实导入 pollUntil / assertCount，删除 declare-only 占位", async () => {
  const src = await fs.readFile(mainPath, "utf8");
  assert.ok(
    /import\s*\{[^}]*\bpollUntil\b[^}]*\bassertCount\b[^}]*\}\s*from\s*"\.\.\/utils\.js"/.test(src),
    "main.ts 必须从 ../utils.js 导入 pollUntil 和 assertCount（修复前是 declare-only 占位）",
  );
  assert.ok(
    !/declare\s+function\s+pollUntilLocal/.test(src),
    "main.ts 不应再保留 declare function pollUntilLocal 占位（运行期会 ReferenceError）",
  );
  assert.ok(
    !/declare\s+function\s+assertCount/.test(src),
    "main.ts 不应再保留 declare function assertCount 占位",
  );
  assert.ok(
    /\bpollUntil\(\s*titleInputs/.test(src),
    "main.ts 必须用真实的 pollUntil 调用，参数是 titleInputs",
  );
});

test("标题数量延迟满足：pollUntil 等待并成功，无 ReferenceError", async () => {
  const expected = 3;
  const locator = makeDelayedCountLocator(expected, 200);
  // 故意用比延迟稍大的 timeout，确保至少观察到一次 0 才等到 target
  const start = Date.now();
  const ready = await pollUntil(
    locator as unknown as Parameters<typeof pollUntil>[0],
    (loc) => loc.count().then((n) => n === expected),
    1_500,
  );
  const elapsed = Date.now() - start;

  assert.equal(ready, true, "count 延迟满足时 pollUntil 必须返回 true");
  assert.ok(
    elapsed >= 150,
    `pollUntil 应当真的等到了 count 变为目标（elapsed=${elapsed}ms，至少 ≥ 一次 150ms 轮询间隔）`,
  );
  assert.ok(locator.calls() >= 2, "count 至少被调用过 2 次：首次 0、之后命中 target");
});

test("超时不满足：assertCount 抛「数量异常」明确错误，而非 undefined / ReferenceError", async () => {
  const locator = makeZeroCountLocator();
  await assert.rejects(
    () => assertCount(locator as unknown as Parameters<typeof assertCount>[0], 2, "每日标题输入框"),
    (error: Error) => {
      // 明确数量错误：消息中包含「数量异常」、期望值、实际值
      assert.match(error.message, /数量异常/, "错误消息必须说明是数量异常");
      assert.match(error.message, /期望\s*2/, "错误消息必须包含期望数量");
      assert.match(error.message, /实际\s*0/, "错误消息必须包含实际数量");
      // 反向断言：不能是 ReferenceError 或「is not defined」之类的 undefined 错误
      assert.doesNotMatch(
        error.message,
        /is not defined|undefined|ReferenceError/,
        "错误必须是 assertCount 的数量错误，不能是 declare-only 占位导致的 undefined 错误",
      );
      return true;
    },
  );
});

test("集成：fillItineraryDraft 在轮询超时后走 assertCount 抛「每日标题输入框数量异常」", async () => {
  // 关键设计：
  //   - 前两次 count() 返回 length=1，使两个 `if (count !== length)` 跳过（不触发 goto / clickSection）；
  //   - 之后 count() 始终返回 0，让 pollUntil 必然超时返回 false；
  //   - 此时 assertCount 必须抛出明确的数量错误，而不是 declare-only 占位导致的 ReferenceError。
  const expectedLength = 1;
  let countCalls = 0;
  const titleLocator = {
    count: async () => {
      countCalls += 1;
      return countCalls <= 2 ? expectedLength : 0;
    },
  };
  const page = {
    // 同一个 locator 复用，避免 goto / clickSection 路径里重新分配对象
    locator: () => titleLocator,
    goto: async () => undefined,
  };
  const product = {
    productId: "P-001",
    itinerary: [{ day: 1, title: "Day 1", description: "..." }],
  };

  await assert.rejects(
    () => fillItineraryDraft(page as unknown as Parameters<typeof fillItineraryDraft>[0], product),
    (error: Error) => {
      assert.match(error.message, /每日标题输入框数量异常/, "必须走 assertCount 的明确数量错误");
      assert.match(error.message, /期望\s*1/, "错误必须包含期望数量 1");
      assert.match(error.message, /实际\s*0/, "错误必须包含实际数量 0");
      // 关键反向断言：不能是「declare-only 占位」导致的 undefined / ReferenceError
      assert.doesNotMatch(
        error.message,
        /is not defined|undefined|ReferenceError|pollUntilLocal/,
        "错误必须来自 assertCount 的数量检查，不能来自未导入的 pollUntilLocal/assertCount 占位",
      );
      return true;
    },
  );
  assert.ok(
    countCalls >= 3,
    `fillItineraryDraft 应当至少轮询 1 次（countCalls=${countCalls}），证明 pollUntil 是真实可调用的运行时函数`,
  );
});