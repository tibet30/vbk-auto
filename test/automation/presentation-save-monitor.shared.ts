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
import { chromium, type Browser, type Page } from "playwright";
import {
  installSaveMonitor,
  SAVE_DESCRIPTION_INFO_PATH,
  CHECK_SENSITIVE_WORD_PATH,
  PresentationSensitiveWordsError,
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
 * 拦截导致，吞掉即可，page.on('response') 会按真实时序触发。
 *
 * 第二个 options 参数：
 *   - `awaitResponse`（默认 `true`）：是否等待 fetch 解析。绝大多数用例依赖
 *     「先发请求 → 等响应回来 → monitor.waitForSave 结算」的时序契约，必须 await。
 *   - **特例**：当被路由的处理器「故意永不响应」（如「敏感词请求永不回响」用例）时，
 *     必须传 `awaitResponse: false`，否则 fetch 永远 pending，evaluate 永远
 *     不返回，整个测试卡死。fire-and-forget 模式下，响应仍会通过 page.on('response')
 *     触发 monitor 内部结算（因为它是真实网络事件，不是 Promise 链上的等待）。 */
async function fireInterceptedPost(
  page: Page,
  pathFragment: string,
  body: any,
  options: { awaitResponse?: boolean } = {},
): Promise<void> {
  const awaitResponse = options.awaitResponse !== false;
  await page.evaluate(
    async ({ url, bodyStr, awaitRes }: { url: string; bodyStr: string; awaitRes: boolean }) => {
      const p = fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: bodyStr,
      }).catch(() => {
        // page.route 拦截后 fetch reject，吞掉即可
      });
      if (awaitRes) {
        // 默认行为：等待响应回到浏览器侧，确保「请求 + 响应」时序后再继续测试
        await p;
      }
      // fire-and-forget：不 await，让 evaluate 立即返回；
      // 真正的响应事件仍会通过 page.on('response') 触发 monitor 的 settle 逻辑
    },
    {
      url: `https://example.com${pathFragment}?test=${Math.random()}`,
      bodyStr: JSON.stringify(body),
      awaitRes: awaitResponse,
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
    // 防御性：先卸掉所有 page.route（部分用例故意挂起请求不响应模拟「敏感词永不回响」），
    // 不先 unrouteAll 的话 page.close() 会等挂起请求收尾而卡死整个进程。
    // ignoreErrors 确保 route 已走完 / 被替换时 unroute 不会因 abort 报错。
    await page.unrouteAll({ behavior: "ignoreErrors" }).catch(() => {});
    await page.close();
  }
}

export { test, assert, installSaveMonitor, SAVE_DESCRIPTION_INFO_PATH, CHECK_SENSITIVE_WORD_PATH,
  PresentationSensitiveWordsError, newPage, mockRoute, fireInterceptedPost, withMonitor };
