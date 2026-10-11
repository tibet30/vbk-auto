// @ts-nocheck
import { test, assert, installSaveMonitor, SAVE_DESCRIPTION_INFO_PATH, CHECK_SENSITIVE_WORD_PATH,
  PresentationSensitiveWordsError, newPage, mockRoute, fireInterceptedPost, withMonitor } from "./presentation-save-monitor.shared.js";

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
    await assert.rejects(() => monitor.waitForSave(), (error: unknown) => {
      assert.ok(error instanceof PresentationSensitiveWordsError);
      assert.deepEqual(error.sensitiveWords, ["违禁词"]);
      assert.equal(error.httpStatus, 200);
      assert.match(error.message, /触发敏感词/);
      return true;
    }, "敏感词命中必须抛可供 AI 恢复链路识别的结构化错误");
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
