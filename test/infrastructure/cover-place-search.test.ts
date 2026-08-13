import test from "node:test";
import assert from "node:assert/strict";
import type { PoiSuggestDetailResult, PoiSuggestCandidate } from "../../src/shared/contracts-types.js";
import type { CoverPlaceBrowser, CoverPlaceImageInfoMap } from "../../src/main/infrastructure/cover-place-search.js";
import { searchCoverPlaceCandidates } from "../../src/main/infrastructure/cover-place-search.js";
import type { CoverPlaceSearchLogEvent } from "../../src/main/infrastructure/cover-place-search-logger.js";
import { flattenPoiTextFields } from "../../src/main/infrastructure/poi-suggest-detail.js";

function candidate(overrides: Partial<PoiSuggestCandidate> & { poiName: string; poiId: number | null }): PoiSuggestCandidate {
  return {
    index: 0,
    poiName: overrides.poiName,
    poiId: overrides.poiId,
    selectable: true,
    textFields: overrides.textFields ?? [],
  };
}

function detail(candidates: PoiSuggestCandidate[]): PoiSuggestDetailResult {
  return {
    httpStatus: 200,
    businessStatus: "Success",
    poiListCount: candidates.length,
    best: null,
    candidates,
  };
}

/** 简易 mock：按 keyword 关键词返回不同结果，便于验证去重 + 优先级。 */
function buildBrowser(table: Record<string, PoiSuggestDetailResult>) {
  const calls: string[] = [];
  return {
    calls,
    browser: {
      async suggestPoiDetail(keyword: string): Promise<PoiSuggestDetailResult> {
        calls.push(keyword);
        const result = table[keyword];
        if (!result) throw new Error(`no mock for ${keyword}`);
        return result;
      },
    },
  };
}

/** 全部请求都抛错的 fake，同样用闭包 calls，避免 this 指向 browser 对象。 */
function buildFailingBrowser(makeError: (keyword: string) => Error) {
  const calls: string[] = [];
  return {
    calls,
    browser: {
      async suggestPoiDetail(keyword: string): Promise<PoiSuggestDetailResult> {
        calls.push(keyword);
        throw makeError(keyword);
      },
    },
  };
}

/** 组合 suggestPoiDetail mock + imageInfo mock，便于验证 imageId → imageUrl 回填。 */
function buildBrowserWithImages(args: {
  table: Record<string, PoiSuggestDetailResult>;
  infoTable?: Map<number, { thumbnailUrl?: string | null; previewUrl?: string | null; originalUrl?: string | null; poiId?: number | null; poiName?: string | null; score?: number | null; resolution?: string | null }>;
  failImageInfo?: Error;
}) {
  const calls: string[] = [];
  const imageCalls: number[][] = [];
  const browser: CoverPlaceBrowser = {
    async suggestPoiDetail(keyword: string): Promise<PoiSuggestDetailResult> {
      calls.push(keyword);
      const result = args.table[keyword];
      if (!result) throw new Error(`no mock for ${keyword}`);
      return result;
    },
  };
  if (args.failImageInfo) {
    const err = args.failImageInfo;
    browser.fetchCtripImageInfo = async (imageIds: ReadonlyArray<number>) => {
      imageCalls.push([...imageIds]);
      throw err;
    };
  } else if (args.infoTable) {
    const table = args.infoTable;
    browser.fetchCtripImageInfo = async (imageIds: ReadonlyArray<number>): Promise<CoverPlaceImageInfoMap> => {
      imageCalls.push([...imageIds]);
      const out = new Map<number, Parameters<NonNullable<CoverPlaceBrowser["fetchCtripImageInfo"]>>[1][number] extends ReadonlyArray<number> ? never : never>();
      // 构造符合 CoverPlaceImageInfoMap 的 Map
      const map = new Map<number, {
        imageId: number | null;
        poiId: number | null;
        poiName: string | null;
        thumbnailUrl: string | null;
        previewUrl: string | null;
        originalUrl: string | null;
        resolution: string | null;
        score: number | null;
        fileName: string | null;
        districtName: string | null;
        countryName: string | null;
        imageUrls: { width: number | null; height: number | null; type: string | null; url: string }[];
      }>();
      for (const id of imageIds) {
        const entry = table.get(id);
        if (!entry) continue;
        map.set(id, {
          imageId: id,
          poiId: entry.poiId ?? null,
          poiName: entry.poiName ?? null,
          thumbnailUrl: entry.thumbnailUrl ?? null,
          previewUrl: entry.previewUrl ?? null,
          originalUrl: entry.originalUrl ?? null,
          resolution: entry.resolution ?? null,
          score: entry.score ?? null,
          fileName: null,
          districtName: null,
          countryName: null,
          imageUrls: [],
        });
      }
      return map as CoverPlaceImageInfoMap;
    };
  }
  return { calls, imageCalls, browser };
}

test("searchCoverPlaceCandidates 单 variant 失败不影响其它候选返回", async () => {
  const fake = buildBrowser({
    "云冈": detail([
      candidate({ index: 0, poiName: "云冈石窟", poiId: 100, textFields: [{ path: "cityName", value: "大同" }, { path: "provinceName", value: "山西" }] }),
    ]),
    "云冈景区": detail([candidate({ index: 0, poiName: "云冈石窟景区", poiId: 200, textFields: [{ path: "cityName", value: "大同" }] })]),
    "云冈景点": detail([candidate({ index: 0, poiName: "云冈石窟景点", poiId: 300 })]),
    "云冈城市": null as unknown as PoiSuggestDetailResult, // simulate failure
  });
  const result = await searchCoverPlaceCandidates(fake.browser as never, "云冈");
  // 3 个 variant 成功 → 恰好 3 个候选；1 个 variant 失败写到 errors。
  assert.deepEqual(
    result.candidates.map((item) => [item.label, item.kind, item.poiId]),
    [
      ["云冈石窟", "keyword", 100],
      ["云冈石窟景区", "scenic", 200],
      ["云冈石窟景点", "spot", 300],
    ],
  );
  assert.equal(result.candidates[0].detail, "大同 · 山西");
  assert.deepEqual(result.errors.map((entry) => entry.variant), ["云冈城市"]);
  assert.equal(result.keyword, "云冈");
  assert.deepEqual([...fake.calls].sort(), ["云冈", "云冈城市", "云冈景区", "云冈景点"].sort());
});

test("searchCoverPlaceCandidates 同名/同 id 候选去重，kind 优先级保留 keyword 胜出", async () => {
  const fake = buildBrowser({
    "太原": detail([candidate({ index: 0, poiName: "太原", poiId: 1 })]),
    "太原景区": detail([candidate({ index: 0, poiName: "太原", poiId: 1 })]),
    "太原景点": detail([candidate({ index: 0, poiName: "太原", poiId: 1 })]),
    "太原城市": detail([candidate({ index: 0, poiName: "太原", poiId: 1 })]),
  });
  const result = await searchCoverPlaceCandidates(fake.browser as never, "太原");
  assert.equal(result.candidates.length, 1, "4 个 variant 同名应合并为 1 条");
  assert.equal(result.candidates[0].kind, "keyword");
  assert.equal(result.candidates[0].poiId, 1);
});

test("searchCoverPlaceCandidates 全部 variant 失败时 errors 全列，candidates 为空", async () => {
  const fake = buildFailingBrowser((keyword) => new Error(`boom for ${keyword}`));
  const result = await searchCoverPlaceCandidates(fake.browser as never, "厦门");
  assert.equal(result.candidates.length, 0);
  assert.equal(result.errors.length, 4, "keyword + 3 variants 共 4 条 error");
  for (const entry of result.errors) {
    assert.match(entry.message, /boom/);
  }
  assert.deepEqual(result.errors.map((entry) => entry.variant), ["厦门", "厦门景区", "厦门景点", "厦门城市"]);
  assert.equal(result.keyword, "厦门");
  assert.equal(fake.calls.length, 4);
});

test("searchCoverPlaceCandidates 空 keyword 直接返回空结果，不调用 browser", async () => {
  const fake = buildBrowser({});
  const result = await searchCoverPlaceCandidates(fake.browser as never, "   ");
  assert.equal(result.keyword, "");
  assert.equal(result.candidates.length, 0);
  assert.equal(result.errors.length, 0);
  assert.equal(fake.calls.length, 0, "空 keyword 不应触发任何 browser 调用");
});

test("searchCoverPlaceCandidates 候选 detail 文本字段归一为 cityName / provinceName / address", async () => {
  const fake = buildBrowser({
    "厦门": detail([
      candidate({
        index: 0,
        poiName: "鼓浪屿",
        poiId: 7,
        textFields: [
          { path: "cityName", value: "厦门" },
          { path: "districtName", value: "思明区" },
          { path: "provinceName", value: "福建" },
        ],
      }),
    ]),
    "厦门景区": detail([]),
    "厦门景点": detail([]),
    "厦门城市": detail([]),
  });
  const result = await searchCoverPlaceCandidates(fake.browser as never, "厦门");
  const found = result.candidates.find((item) => item.label === "鼓浪屿");
  assert.ok(found);
  assert.equal(found?.detail, "厦门 · 思明区 · 福建");
  assert.equal(found?.kind, "keyword");
});

test("searchCoverPlaceCandidates 缺失 poiName 的候选会被丢弃", async () => {
  const fake = buildBrowser({
    "测试": detail([
      candidate({ index: 0, poiName: "  ", poiId: 1 }),
      candidate({ index: 1, poiName: "合法景点", poiId: 2 }),
    ]),
    "测试景区": detail([]),
    "测试景点": detail([]),
    "测试城市": detail([]),
  });
  const result = await searchCoverPlaceCandidates(fake.browser as never, "测试");
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].label, "合法景点");
});

test("searchCoverPlaceCandidates textFields 含 imageUrl 路径会让 candidate.imageUrl 等于该 URL", async () => {
  const imageUrl = "https://images4.c-ctrip.com/foo.jpg";
  const fake = buildBrowser({
    "云冈": detail([
      candidate({
        index: 0,
        poiName: "云冈石窟",
        poiId: 100,
        textFields: [
          { path: "cityName", value: "大同" },
          { path: "imageUrl", value: imageUrl },
        ],
      }),
    ]),
    "云冈景区": detail([]),
    "云冈景点": detail([]),
    "云冈城市": detail([]),
  });
  const result = await searchCoverPlaceCandidates(fake.browser as never, "云冈");
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].imageUrl, imageUrl);
});

test("searchCoverPlaceCandidates 同 id 去重时 keyword 无图、scenic 有图，最终保留 imageUrl", async () => {
  const scenicImage = "https://images4.c-ctrip.com/scenic.jpg";
  const fake = buildBrowser({
    "太原": detail([candidate({ index: 0, poiName: "太原", poiId: 1 })]),
    "太原景区": detail([
      candidate({
        index: 0,
        poiName: "太原",
        poiId: 1,
        textFields: [{ path: "imageUrl", value: scenicImage }],
      }),
    ]),
    "太原景点": detail([candidate({ index: 0, poiName: "太原", poiId: 1 })]),
    "太原城市": detail([candidate({ index: 0, poiName: "太原", poiId: 1 })]),
  });
  const result = await searchCoverPlaceCandidates(fake.browser as never, "太原");
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].kind, "keyword");
  assert.equal(result.candidates[0].imageUrl, scenicImage);
});

test("searchCoverPlaceCandidates 有 imageId 时回填 imageUrl / score / resolution / imageInfoPoiId / imageInfoPoiName", async () => {
  const { calls, imageCalls, browser } = buildBrowserWithImages({
    table: {
      "云冈": detail([
        candidate({
          index: 0,
          poiName: "云冈石窟",
          poiId: 100,
          textFields: [
            { path: "extend[0].imageId", value: "12345" },
            { path: "cityName", value: "大同" },
          ],
        }),
      ]),
      "云冈景区": detail([]),
      "云冈景点": detail([]),
      "云冈城市": detail([]),
    },
    infoTable: new Map([
      [
        12345,
        {
          thumbnailUrl: "https://images.c-ctrip.com/s200/12345.jpg",
          previewUrl: "https://images.c-ctrip.com/s500/12345.jpg",
          originalUrl: "https://images.c-ctrip.com/orig/12345.jpg",
          poiId: 79413,
          poiName: "云冈石窟",
          score: 4.7,
          resolution: "1280*1917",
        },
      ],
    ]),
  });
  const result = await searchCoverPlaceCandidates(browser, "云冈");
  assert.equal(result.candidates.length, 1);
  const [first] = result.candidates;
  assert.ok(first);
  assert.equal(first.poiName, "云冈石窟");
  assert.equal(first.imageId, 12345);
  assert.equal(first.imageUrl, "https://images.c-ctrip.com/s200/12345.jpg");
  assert.equal(first.score, 4.7);
  assert.equal(first.resolution, "1280*1917");
  assert.equal(first.imageInfoPoiId, 79413);
  assert.equal(first.imageInfoPoiName, "云冈石窟");
  // textFields 的 imageUrl 兜底应被 fetchCtripImageInfo 返回的 thumbnailUrl 覆盖。
  assert.deepEqual(calls.sort(), ["云冈", "云冈城市", "云冈景区", "云冈景点"].sort());
  assert.deepEqual(imageCalls, [[12345]]);
  assert.equal(result.errors.length, 0);
});

test("searchCoverPlaceCandidates 多 imageId 时一次性批量回填 + 不同 imageId 互不污染", async () => {
  const { imageCalls, browser } = buildBrowserWithImages({
    table: {
      "山西": detail([
        candidate({
          index: 0,
          poiName: "云冈石窟",
          poiId: 100,
          textFields: [{ path: "imageId", value: "1001" }],
        }),
        candidate({
          index: 1,
          poiName: "平遥古城",
          poiId: 101,
          textFields: [{ path: "imageId", value: "1002" }],
        }),
      ]),
      "山西景区": detail([]),
      "山西景点": detail([]),
      "山西城市": detail([]),
    },
    infoTable: new Map([
      [1001, { thumbnailUrl: "https://images.c-ctrip.com/s200/1001.jpg", score: 4.0, resolution: "800*600", poiId: 200, poiName: "云冈石窟" }],
      [1002, { thumbnailUrl: "https://images.c-ctrip.com/s200/1002.jpg", score: 4.8, resolution: "1024*768", poiId: 201, poiName: "平遥古城" }],
    ]),
  });
  const result = await searchCoverPlaceCandidates(browser, "山西");
  assert.equal(result.candidates.length, 2);
  const yungang = result.candidates.find((c) => c.poiName === "云冈石窟");
  const pingyao = result.candidates.find((c) => c.poiName === "平遥古城");
  assert.ok(yungang && pingyao);
  assert.equal(yungang.imageUrl, "https://images.c-ctrip.com/s200/1001.jpg");
  assert.equal(yungang.score, 4.0);
  assert.equal(yungang.imageInfoPoiId, 200);
  assert.equal(pingyao.imageUrl, "https://images.c-ctrip.com/s200/1002.jpg");
  assert.equal(pingyao.score, 4.8);
  assert.equal(pingyao.imageInfoPoiId, 201);
  // 两个 imageId 应一次性下发，调用次数 = 1。
  assert.equal(imageCalls.length, 1);
  assert.deepEqual([...imageCalls[0]].sort(), [1001, 1002]);
});

test("searchCoverPlaceCandidates 候选无 imageId 时不调用 fetchCtripImageInfo 且不崩", async () => {
  const fake = buildBrowser({
    "云冈": detail([
      candidate({
        index: 0,
        poiName: "云冈石窟",
        poiId: 100,
        // 注意：故意不放 imageId 字段。
        textFields: [{ path: "cityName", value: "大同" }],
      }),
    ]),
    "云冈景区": detail([
      candidate({
        index: 0,
        poiName: "云冈石窟景区",
        poiId: 200,
        textFields: [{ path: "cityName", value: "大同" }],
      }),
    ]),
    "云冈景点": detail([]),
    "云冈城市": detail([]),
  });
  let imageCallCount = 0;
  fake.browser.fetchCtripImageInfo = async () => {
    imageCallCount += 1;
    return new Map();
  };
  const result = await searchCoverPlaceCandidates(fake.browser as never, "云冈");
  assert.equal(result.candidates.length, 2);
  // imageUrl 未回填（textFields 没给，fetchCtripImageInfo 也没给）。
  for (const candidate of result.candidates) {
    assert.equal(candidate.imageUrl, undefined);
    assert.equal(candidate.imageId, undefined);
  }
  assert.equal(imageCallCount, 0, "没有 imageId 时不应调用 fetchCtripImageInfo");
  assert.equal(result.errors.length, 0);
});

test("searchCoverPlaceCandidates browser 完全未注入 fetchCtripImageInfo 时仍能正常返回候选", async () => {
  const fake = buildBrowser({
    "云冈": detail([
      candidate({
        index: 0,
        poiName: "云冈石窟",
        poiId: 100,
        textFields: [{ path: "imageId", value: "999" }],
      }),
    ]),
    "云冈景区": detail([]),
    "云冈景点": detail([]),
    "云冈城市": detail([]),
  });
  // 故意不注入 fetchCtripImageInfo。
  const result = await searchCoverPlaceCandidates(fake.browser as never, "云冈");
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].poiName, "云冈石窟");
  assert.equal(result.candidates[0].imageId, 999);
  // imageUrl 未回填（兜底未触发）。
  assert.equal(result.candidates[0].imageUrl, undefined);
  assert.equal(result.errors.length, 0);
});

test("searchCoverPlaceCandidates fetchCtripImageInfo 抛错时候选仍返回且 errors 记录失败原因", async () => {
  const { calls, imageCalls, browser } = buildBrowserWithImages({
    table: {
      "云冈": detail([
        candidate({
          index: 0,
          poiName: "云冈石窟",
          poiId: 100,
          textFields: [{ path: "imageId", value: "8888" }],
        }),
      ]),
      "云冈景区": detail([]),
      "云冈景点": detail([]),
      "云冈城市": detail([]),
    },
    failImageInfo: new Error("getImageInfo 网络异常"),
  });
  const result = await searchCoverPlaceCandidates(browser, "云冈");
  assert.equal(result.candidates.length, 1, "即使图片补全失败，候选仍返回");
  assert.equal(result.candidates[0].poiName, "云冈石窟");
  assert.equal(result.candidates[0].imageId, 8888);
  // 关键：imageUrl 没有被覆盖为 undefined，依然保持原状（这里原状就是 undefined）。
  assert.equal(result.candidates[0].imageUrl, undefined);
  assert.equal(result.candidates[0].score, undefined);
  // errors 至少记录到 getImageInfo 失败原因，整体查询不中断。
  const imageError = result.errors.find((entry) => entry.variant === "getImageInfo");
  assert.ok(imageError, "errors 中应包含 getImageInfo 失败条目");
  assert.match(imageError!.message, /图片详情查询失败/);
  assert.match(imageError!.message, /getImageInfo 网络异常/);
  // suggestPoiDetail 仍按 4 个 variant 并行调用。
  assert.equal(calls.length, 4);
  assert.equal(imageCalls.length, 1, "失败也应尝试调用一次后被 catch");
});

test("searchCoverPlaceCandidates fetchCtripImageInfo 抛非 Error 时仍写到 errors 不中断候选", async () => {
  const { browser } = buildBrowserWithImages({
    table: {
      "云冈": detail([
        candidate({
          index: 0,
          poiName: "云冈石窟",
          poiId: 100,
          textFields: [{ path: "imageId", value: "7777" }],
        }),
      ]),
      "云冈景区": detail([]),
      "云冈景点": detail([]),
      "云冈城市": detail([]),
    },
    failImageInfo: new Error("boom-string-not-error"),
  });
  // 让 fetchCtripImageInfo 抛一个字符串，验证容错：searchCoverPlaceCandidates 内部
  // 走 `String(error ?? "未知错误")` 兜底。
  browser.fetchCtripImageInfo = async () => {
    throw "boom-string-not-error";
  };
  const result = await searchCoverPlaceCandidates(browser, "云冈");
  assert.equal(result.candidates.length, 1);
  const imageError = result.errors.find((entry) => entry.variant === "getImageInfo");
  assert.ok(imageError);
  assert.match(imageError!.message, /boom-string-not-error/);
});

/**
 * 真实路径风险回归：flattenPoiTextFields 会把嵌套数组/对象展平成
 * `imageList[0].imageId` / `cover.imageId` / `imageIds[0]` 这类 path，
 * extractImageId 必须都能命中，否则候选永远走占位图。
 */
test("searchCoverPlaceCandidates 能从各种嵌套 path 提取 imageId", async () => {
  const paths = ["imageId", "imageIds[0]", "cover.imageId", "imageList[0].imageId", "coverImageIds[2]"];
  for (const [index, path] of paths.entries()) {
    const imageId = 5000 + index;
    const { imageCalls, browser } = buildBrowserWithImages({
      table: {
        "西安": detail([
          candidate({ index: 0, poiName: "西安城墙", poiId: 900 + index, textFields: [{ path, value: `${imageId}` }] }),
        ]),
        "西安景区": detail([]),
        "西安景点": detail([]),
        "西安城市": detail([]),
      },
      infoTable: new Map([[imageId, { thumbnailUrl: `https://images.c-ctrip.com/s200/${imageId}.jpg` }]]),
    });
    const result = await searchCoverPlaceCandidates(browser, "西安");
    assert.deepEqual(imageCalls, [[imageId]], `path ${path} 应提取出 imageId`);
    assert.equal(result.candidates[0].imageUrl, `https://images.c-ctrip.com/s200/${imageId}.jpg`);
  }
});

/** flattenPoiTextFields 的真实输出（嵌套对象/数组）能直接被 extractImageId 消费。 */
test("flattenPoiTextFields 产出的嵌套 imageId path 可被候选提取", async () => {
  const textFields = flattenPoiTextFields({
    poiName: "西安城墙",
    poiId: 900,
    cityName: "西安",
    imageList: [{ imageId: 66001, url: "https://images.c-ctrip.com/x.jpg" }],
  });
  assert.ok(textFields.some((field) => field.path === "imageList[0].imageId"));
  const { imageCalls, browser } = buildBrowserWithImages({
    table: {
      "西安": detail([candidate({ index: 0, poiName: "西安城墙", poiId: 900, textFields })]),
      "西安景区": detail([]),
      "西安景点": detail([]),
      "西安城市": detail([]),
    },
    infoTable: new Map([[66001, { thumbnailUrl: "https://images.c-ctrip.com/s200/66001.jpg" }]]),
  });
  const result = await searchCoverPlaceCandidates(browser, "西安");
  assert.deepEqual(imageCalls, [[66001]]);
  assert.equal(result.candidates[0].imageUrl, "https://images.c-ctrip.com/s200/66001.jpg");
});

/** getImageInfo 返回半空 item 时，不得把 textFields 兜底的 imageUrl 清空。 */
test("searchCoverPlaceCandidates getImageInfo 返回空 URL 时保留 textFields 兜底图", async () => {
  const { browser } = buildBrowserWithImages({
    table: {
      "西安": detail([
        candidate({
          index: 0,
          poiName: "西安城墙",
          poiId: 901,
          textFields: [
            { path: "imageId", value: "70001" },
            { path: "imageUrl", value: "https://images.c-ctrip.com/fallback.jpg" },
          ],
        }),
      ]),
      "西安景区": detail([]),
      "西安景点": detail([]),
      "西安城市": detail([]),
    },
    infoTable: new Map([[70001, { thumbnailUrl: null, previewUrl: null, originalUrl: null }]]),
  });
  const result = await searchCoverPlaceCandidates(browser, "西安");
  assert.equal(result.candidates[0].imageUrl, "https://images.c-ctrip.com/fallback.jpg");
});

/** 简易 event spy：把每条 logger event 推入数组，断言「收到了 X 但没收到 Y」。 */
function captureLogger() {
  const events: CoverPlaceSearchLogEvent[] = [];
  const logger = (record: CoverPlaceSearchLogEvent) => {
    events.push(record);
  };
  return { events, logger };
}

/**
 * cover-ipc 注入的 logger 在「无 imageId」分支应发出 skip-image-info：
 *  - 走 cachedImageIds.length === 0 的 else 分支，reason 明确写出 no imageIds；
 *  - 同时打 search-start + candidates-after-dedup，作为最小闭环；
 *  - 不应进入 image-info-request-start / image-info-success。
 */
test("searchCoverPlaceCandidates logger：无 imageId 时发出 skip-image-info，不发 request-start / success", async () => {
  const fake = buildBrowser({
    "云冈": detail([
      candidate({
        index: 0,
        poiName: "云冈石窟",
        poiId: 100,
        textFields: [{ path: "cityName", value: "大同" }],
      }),
    ]),
    "云冈景区": detail([]),
    "云冈景点": detail([]),
    "云冈城市": detail([]),
  });
  fake.browser.fetchCtripImageInfo = async () => new Map();
  const { events, logger } = captureLogger();
  await searchCoverPlaceCandidates(fake.browser as never, "云冈", { logger });
  const kinds = events.map((event) => event.event);
  assert.deepEqual(kinds[0], "search-start", "首条事件应为 search-start");
  assert.ok(kinds.includes("candidates-after-dedup"), "应发出 candidates-after-dedup");
  const skip = events.find((event) => event.event === "skip-image-info");
  assert.ok(skip && skip.event === "skip-image-info", "无 imageId 时应发出 skip-image-info");
  assert.match(skip.reason, /no imageIds/);
  assert.equal(skip.candidateCount, 1);
  assert.ok(
    !kinds.includes("image-info-request-start"),
    "无 imageId 时不应发出 image-info-request-start",
  );
  assert.ok(
    !kinds.includes("image-info-success"),
    "无 imageId 时不应发出 image-info-success",
  );
});

/**
 * cover-ipc 注入的 logger 在「有 imageId」分支应发出完整事件链：
 * search-start → candidates-after-dedup → image-ids-extracted →
 * image-info-request-start → image-info-success。
 * 同时断言 imageInfoEndpoint 透传成功（不带 endpoint 时不该看到外部 URL）。
 */
test("searchCoverPlaceCandidates logger：有 imageId 时发出 request-start + success，且 imageInfoEndpoint 透传", async () => {
  const { imageCalls, browser } = buildBrowserWithImages({
    table: {
      "云冈": detail([
        candidate({
          index: 0,
          poiName: "云冈石窟",
          poiId: 100,
          textFields: [{ path: "imageId", value: "12345" }],
        }),
      ]),
      "云冈景区": detail([]),
      "云冈景点": detail([]),
      "云冈城市": detail([]),
    },
    infoTable: new Map([
      [12345, { thumbnailUrl: "https://images.c-ctrip.com/s200/12345.jpg", poiName: "云冈石窟", poiId: 79413 }],
    ]),
  });
  const { events, logger } = captureLogger();
  const endpoint = "https://online.ctrip.com/restapi/soa2/12719/getImageInfo";
  await searchCoverPlaceCandidates(browser, "云冈", {
    logger,
    imageInfoEndpoint: endpoint,
  });
  assert.deepEqual(imageCalls, [[12345]]);
  const eventsByKind = new Map(events.map((event) => [event.event, event]));
  assert.ok(eventsByKind.has("search-start"));
  assert.ok(eventsByKind.has("candidates-after-dedup"));
  const extracted = eventsByKind.get("image-ids-extracted");
  assert.ok(extracted && extracted.event === "image-ids-extracted");
  assert.deepEqual([...extracted.imageIds], [12345], "image-ids-extracted 应携带截断后的 imageId 列表");
  const requestStart = eventsByKind.get("image-info-request-start");
  assert.ok(requestStart && requestStart.event === "image-info-request-start");
  assert.equal(requestStart.endpoint, endpoint, "imageInfoEndpoint 应原样下传给 request-start 事件");
  assert.deepEqual([...requestStart.imageIds], [12345]);
  const success = eventsByKind.get("image-info-success");
  assert.ok(success && success.event === "image-info-success");
  assert.equal(success.httpStatus, 200);
  assert.equal(success.ack, "Success");
  assert.equal(success.itemCount, 1);
  assert.equal(success.imageIdCount, 1);
  assert.ok(success.durationMs >= 0);
  assert.ok(!eventsByKind.has("skip-image-info"), "有 imageId 时不应再发出 skip-image-info");
});

/**
 * 用 createConsoleCoverPlaceLogger 拿到 sink 行：顺手验证 console.warn 输出
 * 不带原始 imageUrls / cookie / token / 大段字符串，便于主进程 grep。
 */
test("cover-place-search-logger 的 console.warn 行不泄漏敏感字段", async () => {
  const lines: string[] = [];
  const sink = (line: string) => lines.push(line);
  const consoleLogger = (
    await import("../../src/main/infrastructure/cover-place-search-logger.js")
  ).createConsoleCoverPlaceLogger({ sink });
  consoleLogger({ event: "search-start", keyword: "云冈" });
  consoleLogger({
    event: "image-ids-extracted",
    imageIds: [1001, 1002],
  });
  consoleLogger({
    event: "image-info-request-start",
    imageIds: [1001, 1002, 1003],
    endpoint: "https://online.ctrip.com/restapi/soa2/12719/getImageInfo",
  });
  consoleLogger({
    event: "image-info-success",
    httpStatus: 200,
    ack: "Success",
    itemCount: 1,
    imageIdCount: 3,
    durationMs: 42,
  });
  const joined = lines.join("\n");
  for (const keyword of ["imageList", "imageUrls", "originalPath", "cookie=", "token", "Token", "set-cookie", "Set-Cookie"]) {
    assert.ok(
      !joined.toLowerCase().includes(keyword.toLowerCase()),
      `console.warn 行不应出现 ${keyword}：实际 ${joined}`,
    );
  }
  // 必须出现 imageId 计数 + ack=Success 这类可观测字段。
  assert.match(joined, /ack=Success/);
  assert.match(joined, /imageIdCount=3/);
});
