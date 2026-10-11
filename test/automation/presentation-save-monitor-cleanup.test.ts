// @ts-nocheck
import { test, assert, installSaveMonitor, SAVE_DESCRIPTION_INFO_PATH, CHECK_SENSITIVE_WORD_PATH,
  PresentationSensitiveWordsError, newPage, mockRoute, fireInterceptedPost, withMonitor } from "./presentation-save-monitor.shared.js";

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

/** 「敏感词请求飞出但响应永不回响」的异常 ordering：save 响应到达时如果
 *  pendingSensitive>0 但已经超过 sensitiveWordTimeoutMs 窗口，runner 必须
 *  不再继续缓存，强制按 save 业务结果结算。永远等敏感词响应会卡死 waitForSave。 */
test("save monitor：敏感词请求飞出但响应永不回响 + save 响应后到 → 强制结算 save 不挂", async () => {
  await withMonitor(
    { saveTimeoutMs: 5_000, sensitiveWordTimeoutMs: 300 },
    async ({ page, monitor }) => {
      // 拦截敏感词：永远不真的发出去（page.route 接收但不调用 route.fulfill，
      // 浏览器请求会一直挂着不返回）。
      await page.route(`**${CHECK_SENSITIVE_WORD_PATH}*`, async (route) => {
        // intentionally never call route.fulfill / route.continue
        // 让请求保持挂起，模拟"响应永不回响"
      });
      // 拦截 save 正常返回 success=true
      await mockRoute(page, SAVE_DESCRIPTION_INFO_PATH, 200, {
        success: true,
        ResponseStatus: { Ack: "Success" },
        sensitiveWords: [],
      });
      // 先发敏感词请求（让 request handler 把它记为 pendingSensitive=1）。
      // 该路由 handler 永不响应，所以必须 fire-and-forget；否则 evaluate 内部
      // 的 await fetch() 永不返回，整个测试卡死。响应事件仍会通过 page.on('response')
      // 触发 monitor 内部计时，只是我们不再等待它完成。
      await fireInterceptedPost(
        page,
        CHECK_SENSITIVE_WORD_PATH,
        {
          success: true,
          ResponseStatus: { Ack: "Success" },
          sensitiveWords: [],
        },
        { awaitResponse: false },
      ).catch(() => {});
      // 等 300ms 让 sensitiveWordTimeoutMs 窗口过去
      await new Promise((resolve) => setTimeout(resolve, 400));
      // 再发 save 请求：onSaveResponse 检测到 pendingSensitive>0 但 waitElapsed
      // 已超过窗口，应强制结算
      await fireInterceptedPost(page, SAVE_DESCRIPTION_INFO_PATH, {
        success: true,
        ResponseStatus: { Ack: "Success" },
      });
      const outcome = await monitor.waitForSave();
      assert.equal(outcome.saved, true, "敏感词响应永不回响时，save 响应后到必须按业务结果强制结算");
    },
  );
});

