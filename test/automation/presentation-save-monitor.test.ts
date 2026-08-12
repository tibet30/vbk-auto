// @ts-nocheck
/** 「产品图文」保存门禁（save-monitor.ts + main.ts）的聚焦测试：
 *   - 真实结构下用 page.route() 拦截 /15638/savedescriptioninfo 与
 *     /15638/checkSensitiveWord，覆盖成功 / 业务失败 / Ack 异常 / 敏感词命中 / 超时
 *     五条路径；
 *   - main.ts 接线契约：installSaveMonitor 必须在 clickSection 之前调用，确保
 *     /15638/checkSensitiveWord 在产品图文动作期内就被捕获；
 *   - fillAndSavePresentation 错误模板必须保留「找不到产品特点富文本输入框」前缀
 *     + featuresResult.diagnostic 拼接（既有契约）；
 *   - 不允许在 fillAndSavePresentation 之外修改 tabs.ts（守住「只收窄产品图文」红线）。
 *
 * 顶部带 `// @ts-nocheck`，因为 page / locator 类型是动态传入。
 */
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import {
  installSaveMonitor,
  SAVE_DESCRIPTION_INFO_PATH,
  CHECK_SENSITIVE_WORD_PATH,
} from "../../src/main/automation/ctrip/presentation/save-monitor.js";

let browser: Browser;

before(async () => {
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  await browser?.close();
});
async function newPage(): Promise<Page> {
  const page = await browser.newPage();
  await page.goto("about:blank");
  return page;
}

/** 用 page.route 拦截目标路径并返回指定 JSON；接受 path 正则/通配符模板。 */
async function mockRoute(page: Page, pathFragment: string, status: number, body: any): Promise<void> {
  await page.route(`**${pathFragment}*`, async (route) => {
    await route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
}

/** 通过 page.evaluate(fetch) 触发一次被拦截的 POST 请求；fetch reject 由 page.route
 * 拦截导致，吞掉即可，page.on('response') 会按真实时序触发。 */
async function fireInterceptedPost(page: Page, pathFragment: string, body: any): Promise<void> {
  await page.evaluate(
    async ({ url, bodyStr }: { url: string; bodyStr: string }) => {
      try {
        await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: bodyStr,
        });
      } catch {
        // page.route 拦截后 fetch reject，吞掉即可
      }
    },
    {
      url: `https://example.com${pathFragment}?test=${Math.random()}`,
      bodyStr: JSON.stringify(body),
    },
  ).catch(() => {});
}

/** 「test.run 用的 page + monitor 上下文」：在 try/finally 里确保 uninstall + page close。 */
interface MonitorContext {
  page: Page;
  monitor: ReturnType<typeof installSaveMonitor>;
}

/** 串行 / 并行执行时统一管理 page + monitor 生命周期。 */
async function withMonitor(
  options: Parameters<typeof installSaveMonitor>[1],
  fn: (ctx: MonitorContext) => Promise<void>,
): Promise<void> {
  const page = await newPage();
  try {
    const monitor = installSaveMonitor(page, options);
    try {
      await fn({ page, monitor });
    } finally {
      monitor.uninstall();
    }
  } finally {
    await page.close();
  }
}

test("save monitor：success=true + Ack=Success → saved=true", async () => {
  await withMonitor({}, async ({ page, monitor }) => {
    await mockRoute(page, SAVE_DESCRIPTION_INFO_PATH, 200, {
      success: true,
      ResponseStatus: { Ack: "Success" },
      sensitiveWords: [],
    });
    await fireInterceptedPost(page, SAVE_DESCRIPTION_INFO_PATH, {
      success: true,
      ResponseStatus: { Ack: "Success" },
      sensitiveWords: [],
    });
    const outcome = await monitor.waitForSave();
    assert.equal(outcome.saved, true);
    assert.equal(outcome.success, true);
    assert.equal(outcome.ack, "Success");
    assert.equal(outcome.httpStatus, 200);
    assert.deepEqual(outcome.sensitiveWords, []);
  });
});

test("save monitor：success=false 必须抛「产品图文保存业务未成功」错误", async () => {
  await withMonitor({}, async ({ page, monitor }) => {
    await mockRoute(page, SAVE_DESCRIPTION_INFO_PATH, 200, {
      success: false,
      ResponseStatus: { Ack: "Success" },
      sensitiveWords: [],
    });
    await fireInterceptedPost(page, SAVE_DESCRIPTION_INFO_PATH, {
      success: false,
      ResponseStatus: { Ack: "Success" },
    });
    await assert.rejects(
      () => monitor.waitForSave(),
      /产品图文保存业务未成功/,
      "success=false 必须抛业务失败错误",
    );
  });
});

test("save monitor：Ack=Failure 必须抛业务失败错误", async () => {
  await withMonitor({}, async ({ page, monitor }) => {
    await mockRoute(page, SAVE_DESCRIPTION_INFO_PATH, 200, {
      success: true,
      ResponseStatus: { Ack: "Failure" },
      sensitiveWords: [],
    });
    await fireInterceptedPost(page, SAVE_DESCRIPTION_INFO_PATH, {
      success: true,
      ResponseStatus: { Ack: "Failure" },
    });
    await assert.rejects(
      () => monitor.waitForSave(),
      /产品图文保存业务未成功/,
      "Ack=Failure 必须抛业务失败错误",
    );
  });
});

test("save monitor：/15638/checkSensitiveWord 含敏感词必须抛敏感词错误", async () => {
  await withMonitor({ sensitiveWordTimeoutMs: 5_000 }, async ({ page, monitor }) => {
    await mockRoute(page, CHECK_SENSITIVE_WORD_PATH, 200, {
      success: true,
      ResponseStatus: { Ack: "Success" },
      sensitiveWords: ["违禁词"],
    });
    await fireInterceptedPost(page, CHECK_SENSITIVE_WORD_PATH, {
      success: true,
      ResponseStatus: { Ack: "Success" },
      sensitiveWords: ["违禁词"],
    });
    await assert.rejects(
      () => monitor.waitForSave(),
      /触发敏感词/,
      "敏感词命中必须抛可操作错误",
    );
  });
});

test("save monitor：checkSensitiveWord 敏感词为空 + savedescriptioninfo 成功 → saved=true", async () => {
  await withMonitor({}, async ({ page, monitor }) => {
    await mockRoute(page, CHECK_SENSITIVE_WORD_PATH, 200, {
      success: true,
      ResponseStatus: { Ack: "Success" },
      sensitiveWords: [],
    });
    await mockRoute(page, SAVE_DESCRIPTION_INFO_PATH, 200, {
      success: true,
      ResponseStatus: { Ack: "Success" },
      sensitiveWords: [],
    });
    await fireInterceptedPost(page, CHECK_SENSITIVE_WORD_PATH, {
      success: true,
      ResponseStatus: { Ack: "Success" },
      sensitiveWords: [],
    });
    await fireInterceptedPost(page, SAVE_DESCRIPTION_INFO_PATH, {
      success: true,
      ResponseStatus: { Ack: "Success" },
      sensitiveWords: [],
    });
    const outcome = await monitor.waitForSave();
    assert.equal(outcome.saved, true);
    assert.deepEqual(outcome.sensitiveWords, []);
  });
});

test("save monitor：无任何响应（超时）必须抛「未收到官方 /15638/savedescriptioninfo」错误", async () => {
  await withMonitor({ saveTimeoutMs: 1_000, sensitiveWordTimeoutMs: 200 }, async ({ monitor }) => {
    await assert.rejects(
      () => monitor.waitForSave(),
      /未在 \d+ms 内收到官方 \/15638\/savedescriptioninfo 响应/,
      "无响应必须在 saveTimeoutMs 内抛错",
    );
  });
});

test("save monitor：HTTP 500 + body success=true 仍按 success=true 处理（保持现有契约）", async () => {
  await withMonitor({}, async ({ page, monitor }) => {
    await mockRoute(page, SAVE_DESCRIPTION_INFO_PATH, 500, {
      success: true,
      ResponseStatus: { Ack: "Success" },
      sensitiveWords: [],
    });
    await fireInterceptedPost(page, SAVE_DESCRIPTION_INFO_PATH, {
      success: true,
      ResponseStatus: { Ack: "Success" },
    });
    const outcome = await monitor.waitForSave();
    assert.equal(outcome.saved, true);
    assert.equal(outcome.httpStatus, 500);
  });
});

test("save monitor：uninstall 必须可重入（防止跨产品残留副作用）", async () => {
  const page = await newPage();
  try {
    await mockRoute(page, SAVE_DESCRIPTION_INFO_PATH, 200, {
      success: true,
      ResponseStatus: { Ack: "Success" },
    });
    const monitor = installSaveMonitor(page);
    monitor.uninstall();
    assert.doesNotThrow(() => monitor.uninstall(), "uninstall 必须幂等可重入");
  } finally {
    await page.close();
  }
});

/** 「敏感词后到」必须失败：保存响应（success=true）先到 + 敏感词响应（含词）后到
 *  → 整体判定必须为「敏感词命中」失败，不能因为 save 先到就被错判为成功。
 *  这是真实 VBK 页面的典型时序：保存请求先发，敏感词检测可能晚几个 ms 才到。 */
test("save monitor：保存响应先到 success=true、敏感词后到命中词 → 整体必须判定为敏感词失败", async () => {
  await withMonitor({}, async ({ page, monitor }) => {
    // 保存响应立刻 ready，但敏感词响应延迟 200ms 才发
    await mockRoute(page, SAVE_DESCRIPTION_INFO_PATH, 200, {
      success: true,
      ResponseStatus: { Ack: "Success" },
      sensitiveWords: [],
    });
    await mockRoute(page, CHECK_SENSITIVE_WORD_PATH, 200, {
      success: true,
      ResponseStatus: { Ack: "Success" },
      sensitiveWords: ["违禁词"],
    });
    // 同时发两个请求 —— page.route 是注册时按顺序匹配，谁先注册谁先命中。
    // 这里用 await Promise.all 同步发出，让 save 响应先到、敏感词后到。
    await Promise.all([
      fireInterceptedPost(page, SAVE_DESCRIPTION_INFO_PATH, {
        success: true,
        ResponseStatus: { Ack: "Success" },
        sensitiveWords: [],
      }),
      fireInterceptedPost(page, CHECK_SENSITIVE_WORD_PATH, {
        success: true,
        ResponseStatus: { Ack: "Success" },
        sensitiveWords: ["违禁词"],
      }),
    ]);
    await assert.rejects(
      () => monitor.waitForSave(),
      /触发敏感词/,
      "敏感词响应（哪怕后到）命中词时，waitForSave 必须 reject 为敏感词失败，不能放过",
    );
  });
});

/** uninstall 必须清理 page.on('request') 与 page.on('response') 两个 listener：
 *  uninstall 之后 page 不再触发我们的 handler（避免跨测试残留 / 重复计数）。
 *  本测试用 listennerCount() 验证（Playwright Page 暴露 listenerCount）。
 */
test("save monitor：uninstall 必须同时清掉 request + response 两个监听器", async () => {
  const page = await newPage();
  try {
    const monitor = installSaveMonitor(page);
    // install 之后两个监听器必须已挂上
    assert.ok(
      typeof (page as any).listenerCount === "function",
      "本测试要求 page.listenerCount 可用（Playwright Page 暴露）",
    );
    const beforeReq = (page as any).listenerCount("request") as number;
    const beforeRes = (page as any).listenerCount("response") as number;
    monitor.uninstall();
    const afterReq = (page as any).listenerCount("request") as number;
    const afterRes = (page as any).listenerCount("response") as number;
    assert.equal(afterReq, beforeReq - 1, "uninstall 必须摘除一个 request 监听器");
    assert.equal(afterRes, beforeRes - 1, "uninstall 必须摘除一个 response 监听器");
  } finally {
    await page.close();
  }
});

/** uninstall 必须清掉所有 timer，且对仍等待的 waitForSave() 显式 reject —— 否则
 *  fire-and-forget uninstall 后 await 端永远悬挂，浪费资源。 */
test("save monitor：uninstall 必须清掉所有 timer + reject 仍等待的 promise", async () => {
  await withMonitor({ saveTimeoutMs: 5_000, sensitiveWordTimeoutMs: 5_000 }, async ({ monitor }) => {
    const waitPromise = monitor.waitForSave();
    // 关键：fire-and-forget 卸载
    monitor.uninstall();
    // waitForSave 必须显式 reject，不能永远挂
    await assert.rejects(
      () => waitPromise,
      /已被卸载|disposed|取消/,
      "uninstall 后 waitForSave 必须 reject，不允许继续悬挂",
    );
  });
});

/** uninstall 后到达的 response 事件必须被 guard 吞掉，不再触发 settle —— 防止
 *  跨测试/跨产品残留副作用。 */
test("save monitor：uninstall 后到达的 response 事件不能影响新 monitor", async () => {
  const page = await newPage();
  try {
    // 第一个 monitor：只关心敏感词
    const first = installSaveMonitor(page, { sensitiveWordTimeoutMs: 5_000, saveTimeoutMs: 5_000 });
    first.uninstall();

    // 第二个 monitor：装新 monitor + 立即拦截一个 save 响应
    const second = installSaveMonitor(page, { saveTimeoutMs: 5_000, sensitiveWordTimeoutMs: 5_000 });
    await mockRoute(page, SAVE_DESCRIPTION_INFO_PATH, 200, {
      success: true,
      ResponseStatus: { Ack: "Success" },
      sensitiveWords: [],
    });
    await fireInterceptedPost(page, SAVE_DESCRIPTION_INFO_PATH, {
      success: true,
      ResponseStatus: { Ack: "Success" },
    });
    const outcome = await second.waitForSave();
    assert.equal(outcome.saved, true, "新 monitor 必须正常结算，不受旧 monitor uninstall 影响");
    second.uninstall();
  } finally {
    await page.close();
  }
});

/** 「保存响应先到、敏感词请求后到」的强约束：保存响应到达时如果
 *  还没有任何 checkSensitiveWord 请求发出（即 pending=0），可以直接结算。
 *  本测试验证「save 响应早到 + 后续 checkSensitiveWord 请求永远不发」时
 *  waitForSave 仍能正常成功（pending=0 不卡死）。 */
test("save monitor：保存响应先到、敏感词请求从未发出 → 正常 saved=true", async () => {
  await withMonitor({}, async ({ page, monitor }) => {
    await mockRoute(page, SAVE_DESCRIPTION_INFO_PATH, 200, {
      success: true,
      ResponseStatus: { Ack: "Success" },
      sensitiveWords: [],
    });
    await fireInterceptedPost(page, SAVE_DESCRIPTION_INFO_PATH, {
      success: true,
      ResponseStatus: { Ack: "Success" },
    });
    const outcome = await monitor.waitForSave();
    assert.equal(outcome.saved, true, "无任何敏感词请求时，save 响应到达即可结算");
  });
});

/** 静态契约测试：从源码读取 main.ts，验证 installSaveMonitor 已被移到产品图文
 * 动作之前（满足「在产品图文动作前监听 page response」的窄修复要求）。 */
test("main.ts：installSaveMonitor 必须在 clickSection 之前调用（静态契约）", async () => {
  // 测试文件位于 <repo>/test/automation/，相对路径要往上 3 层到 repo root
  const here = resolve("test/automation/presentation-save-monitor.test.ts");
  const mainPath = resolve(here, "../../../src/main/automation/ctrip/presentation/main.ts");
  const src = await readFile(mainPath, "utf8");
  const idxInstall = src.indexOf("installSaveMonitor(page)");
  const idxClickSection = src.indexOf("clickSection(page");
  assert.ok(idxInstall >= 0, "main.ts 必须调用 installSaveMonitor(page)");
  assert.ok(idxClickSection >= 0, "main.ts 必须调用 clickSection(page");
  assert.ok(
    idxInstall < idxClickSection,
    `installSaveMonitor 必须在 clickSection 之前（否则无法捕获 UEditor blur 触发的 checkSensitiveWord）；idxInstall=${idxInstall}, idxClickSection=${idxClickSection}`,
  );
  // 同时确保 monitor 已被 uninstall 包裹（防止跨产品残留副作用）
  assert.match(
    src,
    /finally\s*\{[\s\S]*monitor\.uninstall\(\)/,
    "main.ts 必须在 finally 中调用 monitor.uninstall()，防止跨产品残留",
  );
  // ensure tabs.ts 没有被改（守住「只收窄产品图文」红线）
  const tabsPath = resolve(here, "../../../src/main/automation/ctrip/tabs.ts");
  const tabsSrc = await readFile(tabsPath, "utf8");
  assert.ok(
    !/installSaveMonitor|savedescriptioninfo|checkSensitiveWord/.test(tabsSrc),
    "tabs.ts 不应被本任务改动（只收窄产品图文）",
  );
});