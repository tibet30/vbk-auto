// @ts-nocheck
/**
 * hotel-resource-package-managed.test.ts
 *
 * 锁死 ensureHotelResource（src/main/automation/ctrip/resources.ts）在
 * 「套餐资源承载住宿、无独立酒店入口」场景下的最小兼容契约：
 *
 *   - 真实 VBK 证据：产品 76906037 的 vehicleResource 段「可添加：酒店」入口数为 0，
 *     但 .ResourceConfig-content-card 中存在住宿晚数>0 的段，每段都有可点
 *     span.item「套餐」（不含 disacitve）。hotelEntry count===0 时，原版会抛
 *     「可配置酒店的住宿行程段数量异常：期望 1，实际 0」导致整段跳过。
 *
 *   - 行为契约（由 chromium + page.setContent 注入 fake DOM 验证）：
 *       count===1 → 保留原钻级配置全流程（必须调用 page.waitForURL(/resourcetype=hotel），
 *                  不返回 packageManaged）；
 *       count===0 + 至少一段住宿晚数>0，且每段都有非 disacitve 的 span.item「套餐」
 *                  → 返回 skipped + packageManaged=true + segments 证据，不写伪 hotelResource；
 *       count===0 + 任何正住宿段缺可用「套餐」入口 → throw 明确错误；
 *       count===0 + 全程无住宿晚数>0 段 → throw 明确错误；
 *       count>1 → throw 明确错误；
 *
 *   - 资源卡异步重渲染契约：count===0 路径必须先等首张 .ResourceConfig-content-card
 *     可见且至少一张含「住宿晚数」，再进入严格 scan/classification；超时明确抛
 *     「资源卡未加载」，不得静默跳过。
 *
 *   - 不允许通过系统级「酒店筛选」文案单独判成功：必须从段卡 DOM 里
 *     真正的 span.item「套餐」出发。
 *
 * 测试用 page.setContent + Proxy wrapPage 拦截 page.goto，避免对远端导航的依赖；
 * page 对象保留真实 chromium 的 getByText / evaluate 等能力，使 count/evaluate
 * 直接跑在注入的 DOM 上。
 */

import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { chromium, type Browser, type Page } from "playwright";
import { ensureHotelResource } from "../../src/main/automation/ctrip/resources.js";

let browser: Browser;

before(async () => {
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  await browser?.close();
});

/** Proxy wrap：拦截 goto / waitForURL，避免测试中真实导航与超时等待。 */
interface StubOverrides {
  goto?: (url: string, options?: unknown) => Promise<unknown>;
  waitForURL?: (regex: RegExp, options?: unknown) => Promise<unknown>;
}

function wrapPage(page: Page, overrides: StubOverrides = {}): Page {
  const wrap = new Proxy(page, {
    get(target, prop, receiver) {
      if (prop === "goto") {
        return overrides.goto ?? (async () => undefined);
      }
      if (prop === "waitForURL") {
        return overrides.waitForURL ?? (async () => undefined);
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return wrap as unknown as Page;
}

async function newPageWith(html: string): Promise<Page> {
  const page = await browser.newPage();
  await page.goto("about:blank");
  await page.setContent(html, { waitUntil: "domcontentloaded" });
  return page;
}

/** 行程含住宿、3 钻等级的最小产品对象 —— 与 resources.ts 入口契约对齐。 */
function buildProduct(hotelTier = "当地3钻酒店/-3") {
  return {
    operations: { hotelTier },
    itinerary: [
      { day: 1, hotel: { name: "X" } },
      { day: 2, hotel: null },
    ],
  };
}

const productId = 76906037;

/** 第 4 个可选参 options：把资源卡等待超时压短，避免用例被默认 12s 拖慢。 */
function withCardTimeout(cardTimeoutMs: number) {
  return { cardTimeoutMs };
}

// ─────────────────────── 1. direct hotel 路径不被跳过 ───────────────────────

test("direct hotelEntry count===1 时不被跳过：必须进入原钻级配置全流程", async () => {
  // 故意放一个套餐托管 segment（防回归到 package-managed 路径），
  // 同时只放 1 个「酒店」入口；验证函数在 count===1 时走 waitForURL 直链。
  const inner = `
    <div class="ResourceConfig-content-card">
      <div class="ResourceConfig-segment-title">行程段1</div>
      <div>住宿晚数1</div>
      <span class="item">套餐</span>
    </div>
    <span>酒店</span>
  `;
  const page = await newPageWith(
    `<html><body><div>资源配置</div>${inner}</body></html>`,
  );
  let directFlowTriggered = false;
  try {
    const stubPage = wrapPage(page, {
      waitForURL: async () => {
        directFlowTriggered = true;
        throw new Error("forced-direct-flow-tracker");
      },
    });
    await assert.rejects(
      () => ensureHotelResource(stubPage, buildProduct(), productId),
      (err: Error) => /forced-direct-flow-tracker/.test(err.message),
      "count===1 时应进入原直钻级配置流程并在 waitForURL 处停下",
    );
    assert.ok(
      directFlowTriggered,
      "count===1 时函数必须调用 waitForURL(/resourcetype=hotel)，不能走 package-managed skip",
    );
  } finally {
    await page.close();
  }
});

// ─────────────────────── 2. 套餐托管成功 ───────────────────────

test("套餐托管成功：count===0 + 正住宿段有可用「套餐」入口，返回 packageManaged + segments 证据", async () => {
  // 真实 VBK 证据形态：段1 含 2 日套餐（masterResourceId/servant/child 三种），段2 住宿晚数=0。
  const inner = `
    <div class="ResourceConfig-content-card">
      <div class="ResourceConfig-segment-title">行程段1</div>
      <div>住宿晚数1</div>
      <span class="item" data-resource="76930872">套餐</span>
      <span class="item" data-resource="76930873">套餐</span>
      <span class="item" data-resource="76930874">套餐</span>
    </div>
    <div class="ResourceConfig-content-card">
      <div class="ResourceConfig-segment-title">行程段2</div>
      <div>住宿晚数0</div>
    </div>
  `;
  const page = await newPageWith(
    `<html><body><div>资源配置</div>${inner}</body></html>`,
  );
  try {
    const result = await ensureHotelResource(
      wrapPage(page),
      buildProduct(),
      productId,
      withCardTimeout(2_000),
    );
    // 1) 必须明确 skipped 理由（不允许「未发现 / 数量异常」之类含糊错误）
    assert.equal(result.skipped, "套餐资源承载住宿，无独立酒店入口");
    // 2) 必须声明 packageManaged，让上游可以走 package 资源承载住宿分支
    assert.equal(result.packageManaged, true);
    // 3) 必须携带分段证据（含 title / stayNights / 套餐入口计数）
    assert.ok(Array.isArray(result.segments), "result.segments 必须是数组");
    assert.equal(result.segments.length, 2, "应有 2 个段卡片");
    const positive = result.segments.filter((s: any) => s.stayNights > 0);
    assert.equal(positive.length, 1, "应有 1 个住宿晚数>0 的段");
    assert.equal(positive[0].stayNights, 1);
    assert.equal(positive[0].enabledPackageCount, 3, "段1 必须有 3 个可用「套餐」入口");
    assert.equal(positive[0].packageItemCount, 3);
    assert.match(positive[0].title, /行程段1/, "应记录段标题");
    const negative = result.segments.filter((s: any) => s.stayNights === 0);
    assert.equal(negative.length, 1, "应有 1 个住宿晚数=0 的段");
    assert.equal(negative[0].enabledPackageCount, 0, "段2 不应误计套餐入口");
    assert.equal(result.positiveSegmentCount, 1);
    // 4) 不允许写伪 hotelResource（packageManaged 路径下 hotelResource 应保持未注入）
    assert.equal(
      (result as any).hotelResource,
      undefined,
      "packageManaged 路径不得伪造 hotelResource",
    );
    assert.equal(
      (result as any).resourceId,
      undefined,
      "packageManaged 路径不得伪造 resourceId",
    );
  } finally {
    await page.close();
  }
});

// ─────────────────────── 3. 住宿无套餐失败 ───────────────────────

test("住宿无套餐失败：count===0 + 正住宿段缺少可用「套餐」入口 → 抛错", async () => {
  const inner = `
    <div class="ResourceConfig-content-card">
      <div class="ResourceConfig-segment-title">行程段1</div>
      <div>住宿晚数1</div>
      <span class="item disacitve">套餐</span>
    </div>
  `;
  const page = await newPageWith(
    `<html><body><div>资源配置</div>${inner}</body></html>`,
  );
  try {
    await assert.rejects(
      () =>
        ensureHotelResource(
          wrapPage(page),
          buildProduct(),
          productId,
          withCardTimeout(2_000),
        ),
      (err: Error) => {
        assert.match(
          err.message,
          /缺少可用「套餐」入口/,
          "错误必须明确指出「套餐入口」缺失",
        );
        assert.match(
          err.message,
          /行程段1/,
          "错误必须包含出问题的段标题，便于排查",
        );
        assert.match(err.message, /住宿晚数\s*1/);
        return true;
      },
    );
  } finally {
    await page.close();
  }
});

test("住宿无套餐失败：count===0 + 正住宿段完全没有「套餐」span → 抛错", async () => {
  // 既无 disabled 套餐、也无 enabled 套餐 —— 也算缺。
  const inner = `
    <div class="ResourceConfig-content-card">
      <div class="ResourceConfig-segment-title">行程段1</div>
      <div>住宿晚数1</div>
      <span class="item">附加资源</span>
    </div>
  `;
  const page = await newPageWith(
    `<html><body><div>资源配置</div>${inner}</body></html>`,
  );
  try {
    await assert.rejects(
      () =>
        ensureHotelResource(
          wrapPage(page),
          buildProduct(),
          productId,
          withCardTimeout(2_000),
        ),
      (err: Error) => /缺少可用「套餐」入口/.test(err.message),
      "段内没有「套餐」span 也必须抛错，不是 silently skip",
    );
  } finally {
    await page.close();
  }
});

// ─────────────────────── 4. 无住宿段失败 ───────────────────────

test("无住宿段失败：count===0 + 所有资源段住宿晚数都为 0 → 抛错", async () => {
  const inner = `
    <div class="ResourceConfig-content-card">
      <div class="ResourceConfig-segment-title">行程段1</div>
      <div>住宿晚数0</div>
      <span class="item">套餐</span>
    </div>
    <div class="ResourceConfig-content-card">
      <div class="ResourceConfig-segment-title">行程段2</div>
      <div>住宿晚数0</div>
    </div>
  `;
  const page = await newPageWith(
    `<html><body><div>资源配置</div>${inner}</body></html>`,
  );
  try {
    await assert.rejects(
      () =>
        ensureHotelResource(
          wrapPage(page),
          buildProduct(),
          productId,
          withCardTimeout(2_000),
        ),
      (err: Error) => /未发现任何「住宿晚数>0」/.test(err.message),
      "所有段住宿晚数=0 必须抛错，绝不能静默 skipped",
    );
  } finally {
    await page.close();
  }
});

// ─────────────────────── 5. 多 hotel 入口失败 ───────────────────────

test("多 hotel 入口失败：count>1 → 抛「数量异常」", async () => {
  const inner = `
    <span>酒店</span>
    <span>酒店</span>
  `;
  const page = await newPageWith(
    `<html><body><div>资源配置</div>${inner}</body></html>`,
  );
  try {
    await assert.rejects(
      () =>
        ensureHotelResource(
          wrapPage(page),
          buildProduct(),
          productId,
          withCardTimeout(2_000),
        ),
      (err: Error) => {
        assert.match(err.message, /可配置酒店的住宿行程段数量异常/);
        assert.match(err.message, /实际\s*2/);
        return true;
      },
    );
  } finally {
    await page.close();
  }
});

// ─────────────────────── 6. 资源卡异步重渲染：100-300ms 延迟注入 + 短 timeout 成功 ───────────────────────

test("资源卡异步渲染：~200ms 后注入资源卡，ensureHotelResource 等待并 packageManaged 成功", async () => {
  // 实机节奏：点击「编辑」后只 delay 500ms，.ResourceConfig-content-card 属异步重渲染。
  // 立即 page.evaluate 时 segments 为空，会被「无任何正住宿段」分支误判。
  // 修复后的 ensureHotelResource 必须先等首张卡 visible 且至少一张卡含「住宿晚数」，
  // 再进入原严格 scan/classification。
  //
  // 本用例：资源卡在 ~200ms 后才插入（落在任务要求的 100-300ms 区间）；
  // 通过 options.cardTimeoutMs=600ms 覆盖默认 12s，确保 ensureHotelResource
  // 能看到 200ms 注入并成功 packageManaged，又不致被默认值拖慢。
  const page = await newPageWith(`<html><body><div>资源配置</div></body></html>`);
  try {
    // 异步注入 200ms 后触发，确保 ensureHotelResource 初始扫描时看不到资源卡。
    const injectPromise = page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          setTimeout(() => {
            const card = document.createElement("div");
            card.className = "ResourceConfig-content-card";
            card.innerHTML = `
              <div class="ResourceConfig-segment-title">行程段1</div>
              <div>住宿晚数1</div>
              <span class="item" data-resource="76930872">套餐</span>
              <span class="item" data-resource="76930873">套餐</span>
            `;
            document.body.appendChild(card);
            resolve();
          }, 200);
        }),
    );
    const result = await ensureHotelResource(
      wrapPage(page),
      buildProduct(),
      productId,
      withCardTimeout(600),
    );
    await injectPromise;

    // packageManaged 路径契约（与既有「套餐托管成功」用例一致）
    assert.equal(result.packageManaged, true);
    assert.equal(result.skipped, "套餐资源承载住宿，无独立酒店入口");
    assert.ok(Array.isArray(result.segments), "segments 必须是数组");
    assert.equal(result.segments.length, 1, "注入 1 张卡，segments 长度应为 1");
    assert.equal(result.segments[0].stayNights, 1);
    assert.equal(result.segments[0].enabledPackageCount, 2);
    assert.equal(result.segments[0].packageItemCount, 2);
    assert.match(result.segments[0].title, /行程段1/);
    assert.equal(result.positiveSegmentCount, 1);
    assert.equal(
      (result as any).hotelResource,
      undefined,
      "packageManaged 路径不得伪造 hotelResource",
    );
  } finally {
    await page.close();
  }
});

// ─────────────────────── 7. 资源卡永不出现：50-100ms 短 timeout 必失败 ───────────────────────

test("资源卡永不出现：传短 timeout 确保抛「资源卡未加载」明确错误（不允许静默 skip）", async () => {
  // options.cardTimeoutMs=80ms（落在 50-100ms 区间）：资源卡永不注入，必然超时。
  // 不需要 finally 中还原任何全局状态：函数现在已无可变全局 / setter。
  const page = await newPageWith(`<html><body><div>资源配置</div></body></html>`);
  try {
    await assert.rejects(
      () =>
        ensureHotelResource(
          wrapPage(page),
          buildProduct(),
          productId,
          withCardTimeout(80),
        ),
      (err: Error) => {
        assert.match(
          err.message,
          /资源卡未加载/,
          "必须抛明确「资源卡未加载」错误，而非「数量异常」或「无住宿段」",
        );
        assert.match(
          err.message,
          /\.ResourceConfig-content-card/,
          "错误必须指向资源卡选择器，便于排查",
        );
        assert.match(err.message, /住宿晚数/, "错误必须指向等待的卡片文本标记");
        assert.doesNotMatch(
          err.message,
          /可配置酒店的住宿行程段数量异常/,
          "永不出现场景不应误报为 count 异常",
        );
        assert.doesNotMatch(
          err.message,
          /未发现任何「住宿晚数>0」/,
          "永不出现场景不应误报为 no-lodging（否则等于 silently skip）",
        );
        return true;
      },
    );
  } finally {
    await page.close();
  }
});
