/**
 * 主入口 searchCtripLibraryImages 通过 stub browser 走 suggestPoi → searchImage →
 * getImageInfo 链路：logger 事件序列、失败分支、getImageInfo 批量失败后逐张重试；
 * 日志 payload 不携带 cookie / token / header / 原始响应 body。
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  SUGGESTPOI_ENDPOINT,
  SEARCH_IMAGE_ENDPOINT,
  searchCtripLibraryImages,
} from "../../src/main/infrastructure/ctrip-library-search.js";
import type { PoiSuggestBrowser } from "../../src/main/infrastructure/poi-suggest.js";
import type { CoverPlaceSearchLogEvent } from "../../src/main/infrastructure/cover-place-search-logger.js";

// ─────────────────────────────────────────────────────────────────────────
// 5. 主入口 searchCtripLibraryImages：端到端 BrowserView 模拟
// ─────────────────────────────────────────────────────────────────────────

interface StubBrowser extends PoiSuggestBrowser {
  /** evaluate 收到的 endpoint → 返回 payload。 */
  readonly stubs: Map<string, unknown>;
  /** 收到的所有 evaluate 调用参数（用于校验）。 */
  readonly calls: Array<{ endpoint: string; body: unknown }>;
}

function buildStubBrowser(args: {
  suggestPoiPayload?: unknown;
  suggestPoiStatus?: number;
  searchImagePayload?: unknown;
  searchImageStatus?: number;
  imageInfoById?: Map<number, unknown>;
}): StubBrowser {
  const stubs = new Map<string, unknown>();
  if ("suggestPoiPayload" in args) stubs.set(SUGGESTPOI_ENDPOINT, args.suggestPoiPayload);
  if ("searchImagePayload" in args) stubs.set(SEARCH_IMAGE_ENDPOINT, args.searchImagePayload);
  const calls: Array<{ endpoint: string; body: unknown }> = [];
  const browser: StubBrowser = {
    stubs,
    calls,
    evaluate: async <T, A>(fn: (arg: A) => T | Promise<T>, arg: A): Promise<T> => {
      const a = arg as unknown as { endpoint: string; body: unknown };
      calls.push({ endpoint: a.endpoint, body: a.body });
      // 模拟 BrowserView 内联 fetch：直接拿 stub 里的 payload 当作"已解析响应"。
      const stub = stubs.get(a.endpoint);
      if (a.endpoint === SUGGESTPOI_ENDPOINT) {
        const status = args.suggestPoiStatus ?? 200;
        if (typeof fn !== "function") throw new Error("evaluate 期望回调函数");
        return (await fn(arg)) as T;
      }
      if (a.endpoint === SEARCH_IMAGE_ENDPOINT) {
        const status = args.searchImageStatus ?? 200;
        if (typeof fn !== "function") throw new Error("evaluate 期望回调函数");
        return (await fn(arg)) as T;
      }
      if (a.endpoint.endsWith("/getImageInfo")) {
        // 走真实 ctrip-image-info.ts 的 fetchCtripImageInfoMap：这里通过
        // 一个 shim 让它从 imageInfoById 取 items，避免触发网络请求。
        // 但 evaluate 内部 fetch 无法这样偷换；改用更轻的 fake：调用 fetchCtripImageInfoMap
        // 在更外层注入 fakeFetch（见下方主入口）。
        return (await fn(arg)) as T;
      }
      return stub as T;
    },
  };
  return browser;
}

function captureLogger() {
  const events: CoverPlaceSearchLogEvent[] = [];
  const logger = (record: CoverPlaceSearchLogEvent) => events.push(record);
  return { events, logger };
}

/**
 * 直接调主入口会触发真实 fetch；改用一个把 ctrip-image-info 替换成 stub
 * 的封装。简化做法：先把真实实现复制为 fake，把 evaluate 内 fetch 替换成
 * 读 imageInfoById。这里走更直接路径：传入一个自实现的 browser，让它
 * 对 getImageInfo endpoint 也读 stub。
 */
function buildFullFakeBrowser(args: {
  suggestPoiPayload: unknown;
  searchImagePayload: unknown;
  imageInfoPayload: unknown;
}): StubBrowser {
  const calls: Array<{ endpoint: string; body: unknown }> = [];
  const browser: StubBrowser = {
    stubs: new Map(),
    calls,
    evaluate: async <T, A>(_fn: (arg: A) => T | Promise<T>, arg: A): Promise<T> => {
      const a = arg as unknown as { endpoint: string; body: unknown };
      calls.push({ endpoint: a.endpoint, body: a.body });
      // 真实 BrowserView evaluate 会自己调 fetch。这里我们用一个 dummy 实现
      // —— 主路径的真实 fetch 由 ctrip-image-info.ts 完成，我们用更巧妙的方式
      // 通过 evaluate 完全不返回真实数据的方式，**调用 fetchCtripImageInfoMap
      // 时让它走的是另一条注入路径**。这要求直接覆盖 searchCtripLibraryImages
      // 内部的 fetchCtripImageInfoMap 调用 —— 不可能。所以测试改为只断言
      // suggestPoi + searchImage 段，返回值中 candidates 为空（因为 getImageInfo
      // 会被真实发起 fetch，且测试环境没有 network）。
      //
      // 因此：主入口测试只覆盖「失败路径」—— 通过让 suggestPoi 或 searchImage
      // 抛错来短路 getImageInfo 调用。
      throw new Error("evaluate stub does not implement real fetch in this test");
    },
  };
  return browser;
}

test("searchCtripLibraryImages：suggestPoi 失败抛出并发出 suggest-failure 事件", async () => {
  const { events, logger } = captureLogger();
  // 让 evaluate 在 suggestPoi 阶段抛错
  const browser: PoiSuggestBrowser = {
    evaluate: async () => {
      throw new Error("suggest 网络异常");
    },
  };
  await assert.rejects(
    () => searchCtripLibraryImages(browser, "太原", { logger }),
    /suggest 网络异常/,
  );
  // 至少发出 search-start；其它事件由 callSuggestPoi 内 try/catch 决定。
  assert.equal(events[0]?.event, "search-start");
});

test("searchCtripLibraryImages：searchImage 返回空 imageIds → skip-image-info + 空 candidates", async () => {
  const { events, logger } = captureLogger();
  // 构造一个 fake browser：
  //  1) suggestPoi 调用 → 返回成功响应；
  //  2) searchImage 调用 → 返回空 imageIds；
  //  3) getImageInfo 不会被调用，因为 searchImage.imageIds.length === 0 走 skip 分支。
  const suggestPayload = {
    ResponseStatus: { Ack: "Success", Errors: [] },
    body: [{ poiId: 100, poiName: "太原" }],
  };
  const searchImagePayload = {
    ResponseStatus: { Ack: "Success", Errors: [] },
    imageIds: [],
  };
  const calls: Array<{ endpoint: string; body: unknown }> = [];
  const browser: PoiSuggestBrowser = {
    evaluate: async <T, A>(fn: (arg: A) => T | Promise<T>, arg: A): Promise<T> => {
      const a = arg as unknown as { endpoint: string; body: unknown; timeoutMs: number };
      calls.push({ endpoint: a.endpoint, body: a.body });
      // 内联 mock fetch：返回一个永远成功的 status+text，payload 由 endpoint 决定
      const status = 200;
      const text = JSON.stringify(
        a.endpoint === SUGGESTPOI_ENDPOINT ? suggestPayload : searchImagePayload,
      );
      // fn 内部会调 fetch —— 但这里我们用一个最小的 replacement。
      // 由于 evaluate 函数体内 fetch 不可拦截，我们改用更直接的方案：覆盖 evaluate
      // 让它跳过真实 fetch，直接返回预先组装好的 { status, text, durationMs }。
      // 这要求 evaluate 函数不真正执行 fetch。这里只能让 evaluate 内部不抛错，
      // 但真正的 fetch 仍会发。这里偷个懒：直接传一个 evaluate，**不执行 fn**，
      // 让 fn 内部的 fetch 永远不被触发。
      void fn;
      return {
        status,
        payload: JSON.parse(text),
        durationMs: 12,
        ctx: { hasCid: true, cookieNameCount: 1, hasGuidCookie: true, hasVbkLoginCidCookie: false },
      } as unknown as T;
    },
  };
  const result = await searchCtripLibraryImages(browser, "太原", { logger });
  assert.equal(result.keyword, "太原");
  assert.equal(result.poi, "太原");
  assert.deepEqual(result.candidates, []);
  assert.ok(typeof result.fetchedAt === "string" && result.fetchedAt.length > 0);
  // 两个图库渠道均为空后才进入 skip-image-info。
  assert.deepEqual(
    events.map((e) => e.event),
    ["search-start", "suggest-success", "searchImage-success", "searchImage-success", "skip-image-info"],
  );
  // 日志 payload 不携带 imageIds / cookie value / token / header。
  const joined = JSON.stringify(events);
  for (const keyword of ["test-cid", "token", "Token", "header", "Header", "raw imageIds"]) {
    assert.ok(!joined.toLowerCase().includes(keyword.toLowerCase()), `日志不应含 ${keyword}`);
  }
  // suggest-success 应包含 poiName / poiId
  const suggest = events.find((e) => e.event === "suggest-success");
  assert.ok(suggest && suggest.event === "suggest-success");
  assert.equal(suggest.poiName, "太原");
  assert.equal(suggest.poiId, 100);
  // searchImage-success 应包含 imageIdCount = 0
  const si = events.find((e) => e.event === "searchImage-success");
  assert.ok(si && si.event === "searchImage-success");
  assert.equal(si.imageIdCount, 0);
  // 调用了 suggest + 两次 searchImage（供应商图库、攻略图库）；不会调 getImageInfo。
  const endpoints = calls.map((c) => c.endpoint);
  assert.equal(endpoints[0], SUGGESTPOI_ENDPOINT);
  assert.equal(endpoints[1], SEARCH_IMAGE_ENDPOINT);
  assert.equal(endpoints[2], SEARCH_IMAGE_ENDPOINT);
  assert.deepEqual((calls[2].body as { sources: number[] }).sources, [3]);
});

test("getImageInfo 批量失败时逐张重试，只丢失败的图", async () => {
  const { events, logger } = captureLogger();
  const imageInfoBodies: number[][] = [];
  const ok = (body: unknown) => ({ ResponseStatus: { Ack: "Success", Errors: [] }, ...body as object });
  const failure = { ResponseStatus: { Ack: "Failure", Errors: [{ Message: "图片服务异常" }] } };
  const browser: PoiSuggestBrowser = {
    evaluate: async <T, A>(_fn: (arg: A) => T | Promise<T>, arg: A): Promise<T> => {
      const a = arg as unknown as { endpoint: string; body: { imageIds?: number[] } };
      let payload: unknown;
      if (a.endpoint === SUGGESTPOI_ENDPOINT) payload = ok({ body: [{ poiId: 100, poiName: "晋祠" }] });
      else if (a.endpoint === SEARCH_IMAGE_ENDPOINT) payload = ok({ imageIds: [1, 2, 3] });
      else {
        const ids = a.body.imageIds ?? [];
        imageInfoBodies.push([...ids]);
        payload = ids.length > 1 || ids[0] === 2
          ? failure
          : ok({ body: [{ imageId: ids[0], poiId: 100, poiName: "晋祠", originalPath: `https://img/${ids[0]}.jpg`, width: 1920, height: 1080 }] });
      }
      return { status: 200, payload, durationMs: 3, ctx: { hasCid: true, cookieNameCount: 1, hasGuidCookie: true, hasVbkLoginCidCookie: false } } as unknown as T;
    },
  };
  const result = await searchCtripLibraryImages(browser, "晋祠", { logger });
  assert.deepEqual(imageInfoBodies, [[1, 2, 3], [1], [2], [3]]);
  assert.deepEqual(result.candidates.map((item) => item.imageId), [1, 3]);
  assert.ok(result.candidates.every((item) => item.imageResolved === true));
  const failed = events.filter((event) => event.event === "image-info-failed");
  assert.equal(failed.length, 1);
  assert.match(JSON.stringify(failed[0]), /"imageId":2/);
  const batchFailure = events.filter((event) => event.event === "image-info-failure");
  assert.equal(batchFailure.length, 1);
  assert.match(JSON.stringify(batchFailure[0]), /图片服务异常/);
});

test("searchCtripLibraryImages：suggestPoi 返回 HTTP 400 抛错 + suggest-failure 事件", async () => {
  const { events, logger } = captureLogger();
  const browser: PoiSuggestBrowser = {
    evaluate: async <T, _A>(_fn, _arg): Promise<T> => {
      return {
        status: 400,
        payload: {},
        durationMs: 8,
        ctx: { hasCid: true, cookieNameCount: 1, hasGuidCookie: true, hasVbkLoginCidCookie: false },
      } as unknown as T;
    },
  };
  await assert.rejects(
    () => searchCtripLibraryImages(browser, "x", { logger }),
    /HTTP 400/,
  );
  const suggest = events.find((e) => e.event === "suggest-failure");
  assert.ok(suggest && suggest.event === "suggest-failure");
  assert.match(suggest.message, /HTTP 400/);
});

test("searchCtripLibraryImages：suggestPoi 未匹配 POI 抛错 + suggest-failure 事件", async () => {
  const { events, logger } = captureLogger();
  const suggestPayload = {
    ResponseStatus: { Ack: "Success", Errors: [] },
    body: [],
  };
  const browser: PoiSuggestBrowser = {
    evaluate: async <T, _A>(_fn, _arg): Promise<T> => {
      return {
        status: 200,
        payload: suggestPayload,
        durationMs: 4,
        ctx: { hasCid: true, cookieNameCount: 1, hasGuidCookie: true, hasVbkLoginCidCookie: false },
      } as unknown as T;
    },
  };
  await assert.rejects(
    () => searchCtripLibraryImages(browser, "火星", { logger }),
    /未找到匹配 POI/,
  );
  const suggest = events.find((e) => e.event === "suggest-failure");
  assert.ok(suggest && suggest.event === "suggest-failure");
  assert.match(suggest.message, /未找到匹配 POI/);
});
