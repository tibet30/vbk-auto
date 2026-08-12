import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import type { Event, WebContents } from "electron";
import {
  navigateVbkPage,
  normalizeUrlForCompare,
  urlsMatch,
} from "../../src/main/infrastructure/vbk-navigation.js";

/**
 * 极小 WebContents fake：
 *   - 仅暴露 navigateVbkPage 用到的 surface（getURL / loadURL / on / off / emit / listenerCount）；
 *   - 默认的 loadURL 行为是更新内部 url 字段；
 *   - 测试可在 options.loadURL 注入自定义行为（抛错、同步触发 will-prevent-unload 等）。
 *
 * 用 `as unknown as WebContents` 在调用 navigateVbkPage 时做单向类型断言，
 * 因为真实 WebContents 暴露了几百个事件 / 方法，fake 不需要也不该照抄。
 */
interface FakeWebContents {
  getURL(): string;
  loadURL(url: string, options?: unknown): Promise<void>;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  off(event: string, listener: (...args: unknown[]) => void): unknown;
  emit(event: string, ...args: unknown[]): boolean;
  listenerCount(event: string): number;
  setURL(value: string): void;
}

function makeFakeWebContents(options: {
  loadURL?: (url: string) => Promise<void>;
  initialUrl?: string;
}): FakeWebContents {
  const ee = new EventEmitter();
  let url = options.initialUrl ?? "";
  const fake: FakeWebContents = {
    getURL: () => url,
    loadURL: options.loadURL ?? (async (next: string) => {
      url = next;
    }),
    on: ee.on.bind(ee),
    off: ee.off.bind(ee),
    emit: ee.emit.bind(ee),
    listenerCount: ee.listenerCount.bind(ee),
    setURL: (value) => {
      url = value;
    },
  };
  return fake;
}

function asWebContents(fake: FakeWebContents): WebContents {
  return fake as unknown as WebContents;
}

const TARGET = "https://vbooking.ctrip.com/product/input/productImageText?productId=1&pattern=4&from=vbk";
const SOURCE = "https://vbooking.ctrip.com/ivbk/vendor/tourdays?productid=1";

// ─────────────────────────── URL 规范化 ───────────────────────────

test("normalizeUrlForCompare 去掉非根路径的尾斜杠", () => {
  assert.equal(normalizeUrlForCompare("https://x.com/foo/"), "https://x.com/foo");
  assert.equal(normalizeUrlForCompare("https://x.com/foo///"), "https://x.com/foo");
  assert.equal(normalizeUrlForCompare("https://x.com/foo"), "https://x.com/foo");
});

test("normalizeUrlForCompare 保留根路径的斜杠", () => {
  assert.equal(normalizeUrlForCompare("https://x.com"), "https://x.com/");
  assert.equal(normalizeUrlForCompare("https://x.com/"), "https://x.com/");
});

test("normalizeUrlForCompare 忽略 hash 且 protocol/host 小写化", () => {
  assert.equal(
    normalizeUrlForCompare("HTTPS://X.COM/FOO?a=1#frag"),
    "https://x.com/FOO?a=1",
  );
});

test("normalizeUrlForCompare 解析失败 / 空串返回 null", () => {
  assert.equal(normalizeUrlForCompare("not-a-url"), null);
  assert.equal(normalizeUrlForCompare(""), null);
  assert.equal(normalizeUrlForCompare(undefined as unknown as string), null);
});

test("urlsMatch 容忍尾斜杠与 hash 差异", () => {
  assert.equal(urlsMatch("https://x.com/foo", "https://x.com/foo/"), true);
  assert.equal(urlsMatch("https://x.com/foo?a=1#x", "https://x.com/foo/?a=1"), true);
  assert.equal(urlsMatch("https://x.com/foo", "https://x.com/bar"), false);
  assert.equal(urlsMatch("https://x.com/foo", "not-a-url"), false);
});

// ─────────────────────────── 导航主流程 ───────────────────────────

test("正常导航：loadURL 成功且抵达目标时返回，监听器已清理", async () => {
  const fake = makeFakeWebContents({ initialUrl: SOURCE });

  await navigateVbkPage(asWebContents(fake), TARGET);

  assert.equal(fake.getURL(), TARGET);
  assert.equal(fake.listenerCount("will-prevent-unload"), 0, "成功后必须清理监听器");
});

test("beforeunload 拦截：监听 will-prevent-unload 并 event.preventDefault() 放行这一次离页", async () => {
  let preventDefaultCalls = 0;
  let listenersAttachedDuringLoad = -1;
  const fake = makeFakeWebContents({
    initialUrl: SOURCE,
    loadURL: async (url) => {
      // loadURL 调用期间监听器必须已经挂上（否则 beforeunload 拦截无法被放行）。
      listenersAttachedDuringLoad = fake.listenerCount("will-prevent-unload");
      // 模拟 Electron：当前页 beforeunload handler 尝试阻止离页 → 主进程同步派发
      // will-prevent-unload；监听器收到事件后必须调用 preventDefault()。
      const event: Pick<Event, "preventDefault"> = {
        preventDefault: () => {
          preventDefaultCalls += 1;
        },
      };
      fake.emit("will-prevent-unload", event);
      fake.setURL(url);
    },
  });

  await navigateVbkPage(asWebContents(fake), TARGET);

  assert.equal(preventDefaultCalls, 1, "必须调用 event.preventDefault() 放行这一次离页");
  assert.equal(listenersAttachedDuringLoad, 1, "loadURL 调用前监听器必须已挂上");
  assert.equal(fake.listenerCount("will-prevent-unload"), 0, "监听器必须 finally 清理");
});

test("可恢复 ERR_ABORTED：loadURL 抛 ERR_ABORTED 但已抵达目标 → 视作成功（容忍尾斜杠差异）", async () => {
  // target 没有尾斜杠，current 在 pathname 上多一个尾斜杠：模拟 VBK 跳转后路径形态差异。
  const fake = makeFakeWebContents({
    initialUrl: SOURCE,
    loadURL: async (url) => {
      const qIndex = url.indexOf("?");
      const withSlash = qIndex >= 0
        ? `${url.slice(0, qIndex)}/${url.slice(qIndex)}`
        : `${url}/`;
      fake.setURL(withSlash);
      const err = new Error("net::ERR_ABORTED") as Error & { code?: string };
      err.code = "ERR_ABORTED";
      throw err;
    },
  });

  await navigateVbkPage(asWebContents(fake), TARGET);

  assert.equal(
    fake.listenerCount("will-prevent-unload"),
    0,
    "可恢复 ERR_ABORTED 路径也必须 finally 清理监听器",
  );
});

test("真正 ERR_ABORTED：loadURL 抛 ERR_ABORTED 且未到目标 → 抛含 source / target / actual / code 的明确错误", async () => {
  const fake = makeFakeWebContents({
    initialUrl: SOURCE,
    loadURL: async () => {
      const err = new Error("net::ERR_ABORTED") as Error & { code?: string };
      err.code = "ERR_ABORTED";
      throw err;
    },
  });

  await assert.rejects(
    () => navigateVbkPage(asWebContents(fake), TARGET),
    (err: Error & { code?: string }) => {
      assert.equal(err.code, "ERR_ABORTED", "错误 code 必须保留为 ERR_ABORTED");
      assert.match(err.message, /source=/, "错误必须包含 source URL");
      assert.match(err.message, /target=/, "错误必须包含 target URL");
      assert.match(err.message, /actual=/, "错误必须包含 actual URL（最终未到目标）");
      assert.match(err.message, /code=ERR_ABORTED/, "错误必须包含 code=ERR_ABORTED");
      return true;
    },
  );

  assert.equal(
    fake.listenerCount("will-prevent-unload"),
    0,
    "真正 ERR_ABORTED 失败路径也必须 finally 清理监听器",
  );
});

test("非 ERR_ABORTED 错误：原样抛出（含 network / SSL 等），不静默吞错", async () => {
  const fake = makeFakeWebContents({
    initialUrl: SOURCE,
    loadURL: async () => {
      throw new Error("net::ERR_NAME_NOT_RESOLVED");
    },
  });

  await assert.rejects(
    () => navigateVbkPage(asWebContents(fake), TARGET),
    /ERR_NAME_NOT_RESOLVED/,
  );

  assert.equal(
    fake.listenerCount("will-prevent-unload"),
    0,
    "其他错误路径也必须 finally 清理监听器",
  );
});

test("loadURL 成功但 current URL 未抵达目标：抛'未抵达目标'错误（防御服务端重定向）", async () => {
  const fake = makeFakeWebContents({
    initialUrl: SOURCE,
    loadURL: async () => {
      // 模拟服务端把页面重定向到登录页（常见 VBK 行为）。
      fake.setURL("https://vbooking.ctrip.com/login?from=vbk");
    },
  });

  await assert.rejects(
    () => navigateVbkPage(asWebContents(fake), TARGET),
    (err: Error) => {
      assert.match(err.message, /未抵达目标/, "错误必须显式说明未抵达目标");
      assert.match(err.message, /source=/);
      assert.match(err.message, /target=/);
      assert.match(err.message, /actual=/);
      return true;
    },
  );

  assert.equal(fake.listenerCount("will-prevent-unload"), 0, "该路径也必须清理监听器");
});

// ─────────────────────────── 监听清理覆盖 ───────────────────────────

test("监听器在所有错误/成功路径下都被清理：成功 / 可恢复 / 真正 ERR_ABORTED / 其他错误 / 未抵达目标", async () => {
  // 路径 1：成功
  {
    const fake = makeFakeWebContents({ initialUrl: SOURCE });
    await navigateVbkPage(asWebContents(fake), TARGET);
    assert.equal(fake.listenerCount("will-prevent-unload"), 0, "成功路径清理");
  }

  // 路径 2：可恢复 ERR_ABORTED
  {
    const fake = makeFakeWebContents({
      initialUrl: SOURCE,
      loadURL: async (url) => {
        fake.setURL(url);
        const err = new Error("net::ERR_ABORTED") as Error & { code?: string };
        err.code = "ERR_ABORTED";
        throw err;
      },
    });
    await navigateVbkPage(asWebContents(fake), TARGET);
    assert.equal(fake.listenerCount("will-prevent-unload"), 0, "可恢复 ERR_ABORTED 路径清理");
  }

  // 路径 3：真正 ERR_ABORTED（未到目标）
  {
    const fake = makeFakeWebContents({
      initialUrl: SOURCE,
      loadURL: async () => {
        const err = new Error("net::ERR_ABORTED") as Error & { code?: string };
        err.code = "ERR_ABORTED";
        throw err;
      },
    });
    await assert.rejects(() => navigateVbkPage(asWebContents(fake), TARGET));
    assert.equal(fake.listenerCount("will-prevent-unload"), 0, "真正 ERR_ABORTED 路径清理");
  }

  // 路径 4：其他错误
  {
    const fake = makeFakeWebContents({
      initialUrl: SOURCE,
      loadURL: async () => {
        throw new Error("net::ERR_CONNECTION_RESET");
      },
    });
    await assert.rejects(() => navigateVbkPage(asWebContents(fake), TARGET));
    assert.equal(fake.listenerCount("will-prevent-unload"), 0, "其他错误路径清理");
  }

  // 路径 5：loadURL 成功但未抵达目标
  {
    const fake = makeFakeWebContents({
      initialUrl: SOURCE,
      loadURL: async () => {
        fake.setURL("https://vbooking.ctrip.com/login?from=vbk");
      },
    });
    await assert.rejects(() => navigateVbkPage(asWebContents(fake), TARGET));
    assert.equal(fake.listenerCount("will-prevent-unload"), 0, "未抵达目标路径清理");
  }
});

// ─────────────────────────── 输入校验 ───────────────────────────

test("webContents 为 undefined 时抛 'VBK 浏览器尚未初始化'，不挂监听器", async () => {
  await assert.rejects(
    () => navigateVbkPage(undefined, TARGET),
    /VBK 浏览器尚未初始化/,
  );
});

test("URL 为空 / 非字符串时抛错，不挂监听器", async () => {
  const fake = makeFakeWebContents({ initialUrl: SOURCE });
  await assert.rejects(
    () => navigateVbkPage(asWebContents(fake), ""),
    /导航目标 URL 不能为空/,
  );
  await assert.rejects(
    () => navigateVbkPage(asWebContents(fake), "   "),
    /导航目标 URL 不能为空/,
  );
  await assert.rejects(
    () => navigateVbkPage(asWebContents(fake), undefined as unknown as string),
    /导航目标 URL 不能为空/,
  );
  assert.equal(fake.listenerCount("will-prevent-unload"), 0, "校验失败时不应挂监听器");
});

test("URL 格式不正确时抛错，不挂监听器", async () => {
  const fake = makeFakeWebContents({ initialUrl: SOURCE });
  await assert.rejects(
    () => navigateVbkPage(asWebContents(fake), "not-a-url"),
    /格式不正确/,
  );
  assert.equal(fake.listenerCount("will-prevent-unload"), 0, "校验失败时不应挂监听器");
});

test("非 HTTP/HTTPS 协议被拒，不挂监听器", async () => {
  const fake = makeFakeWebContents({ initialUrl: SOURCE });
  await assert.rejects(
    () => navigateVbkPage(asWebContents(fake), "javascript:alert(1)"),
    /仅支持 HTTP \/ HTTPS 导航目标/,
  );
  assert.equal(fake.listenerCount("will-prevent-unload"), 0, "校验失败时不应挂监听器");
});

test("非 VBK 白名单 host 不允许，不挂监听器", async () => {
  const fake = makeFakeWebContents({ initialUrl: SOURCE });
  await assert.rejects(
    () => navigateVbkPage(asWebContents(fake), "https://example.com/foo"),
    /仅允许在内置 VBK 浏览器中打开携程页面/,
  );
  assert.equal(fake.listenerCount("will-prevent-unload"), 0, "校验失败时不应挂监听器");
});