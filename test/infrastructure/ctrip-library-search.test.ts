/**
 * ctrip-library-search 模块的单元测试：
 *   - 纯函数：buildSuggestPoiRequest / buildSearchImageRequest /
 *     parseSuggestPoiPayload / parseSearchImagePayload；
 *   - 多形态响应解析（body / data.body / poiList / imageIds / nested）；
 *   - endpoint 与超时常量；
 *   - 主入口链路测试见 ctrip-library-search-entry.test.ts。
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  SUGGESTPOI_ENDPOINT,
  SEARCH_IMAGE_ENDPOINT,
  SEARCH_IMAGE_MAX_PAGE_SIZE,
  CTRIP_LIBRARY_BROWSER_REQUEST_TIMEOUT_MS,
  CTRIP_LIBRARY_EVALUATE_TIMEOUT_MS,
  buildSuggestPoiRequest,
  buildSearchImageRequest,
  parseSuggestPoiPayload,
  parseSuggestPoiPlaces,
  parseSearchImagePayload,
} from "../../src/main/infrastructure/ctrip-library-search.js";

// ─────────────────────────────────────────────────────────────────────────
// 1. buildSuggestPoiRequest：payload 结构 & trim
// ─────────────────────────────────────────────────────────────────────────

test("buildSuggestPoiRequest：keyword trim 后写入 payload，orderType 留空", () => {
  const request = buildSuggestPoiRequest("  太原  ");
  assert.equal(request.contentType, "json");
  assert.deepEqual(request.head, {
    cid: "",
    ctok: "",
    cver: "1.0",
    lang: "01",
    sid: "8888",
    syscode: "09",
    auth: "",
    xsid: "",
    extension: [],
  });
  assert.equal(request.keyword, "太原");
  assert.equal(request.orderType, "");
});

test("buildSuggestPoiRequest：空 / 全空白 keyword 抛错", () => {
  assert.throws(() => buildSuggestPoiRequest(""), /必须提供景点关键词/);
  assert.throws(() => buildSuggestPoiRequest("   "), /必须提供景点关键词/);
});

// ─────────────────────────────────────────────────────────────────────────
// 2. buildSearchImageRequest：tags / sources / urlOptions / auditStatuses
// ─────────────────────────────────────────────────────────────────────────

test("buildSearchImageRequest：tags / sources / urlOptions / imageClass / excludeGif 与文档一致", () => {
  const request = buildSearchImageRequest({ poiId: 12345 });
  assert.equal(request.contentType, "json");
  assert.equal(request.head.cid, "");
  assert.deepEqual(request.tags, [
    { tagType: "District", tagValue: "" },
    { tagType: "PoiId", tagValue: "12345" },
    { tagType: "Country", tagValue: "" },
  ]);
  assert.deepEqual(request.sources, [1, 9]);
  assert.deepEqual(request.urlOptions, [
    { width: 200, height: 200, quality: 0.9, type: "R" },
    { width: 500, height: 500, quality: 0.9, type: "R" },
  ]);
  assert.equal(request.imageClass, "TourProduct");
  assert.equal(request.pageIndex, 1);
  assert.equal(request.pageSize, 20);
  assert.deepEqual(request.auditStatuses, [4]);
  assert.equal(request.excludeGif, true);
});

test("buildSearchImageRequest：允许供应商图库无图时改查攻略图库", () => {
  const request = buildSearchImageRequest({ poiId: 77498, sources: [3] });
  assert.deepEqual(request.sources, [3]);
  assert.deepEqual(request.tags, [
    { tagType: "District", tagValue: "" },
    { tagType: "PoiId", tagValue: "77498" },
    { tagType: "Country", tagValue: "" },
  ]);
});

test("buildSearchImageRequest：pageSize 自动夹到上限", () => {
  assert.equal(buildSearchImageRequest({ poiId: 1, pageSize: 999 }).pageSize, SEARCH_IMAGE_MAX_PAGE_SIZE);
  assert.equal(buildSearchImageRequest({ poiId: 1, pageSize: 0 }).pageSize, 20);
  assert.equal(buildSearchImageRequest({ poiId: 1, pageSize: -1 }).pageSize, 20);
});

test("buildSearchImageRequest：poiId 必须为正整数", () => {
  assert.throws(() => buildSearchImageRequest({ poiId: 0 }), /正整数 poiId/);
  assert.throws(() => buildSearchImageRequest({ poiId: -1 }), /正整数 poiId/);
  assert.throws(() => buildSearchImageRequest({ poiId: 1.5 }), /正整数 poiId/);
});

// ─────────────────────────────────────────────────────────────────────────
// 3. parseSuggestPoiPayload：多种响应形态
// ─────────────────────────────────────────────────────────────────────────

const successAck = () => ({ Ack: "Success", Errors: [] });

test("parseSuggestPoiPayload：body 数组形态，取首个 poiId + poiName", () => {
  const payload = {
    ResponseStatus: successAck(),
    body: [
      { poiId: 100, poiName: "太原" },
      { poiId: 200, poiName: "西安" },
    ],
  };
  const result = parseSuggestPoiPayload(payload, 200);
  assert.equal(result.httpStatus, 200);
  assert.equal(result.businessStatus, "Success");
  assert.deepEqual(result.poi, { poiId: 100, poiName: "太原" });
});

test("parseSuggestPoiPayload：data.poiList 形态", () => {
  const payload = {
    ResponseStatus: successAck(),
    data: {
      poiList: [
        { poiId: 888, poiName: "云冈石窟" },
      ],
    },
  };
  const result = parseSuggestPoiPayload(payload);
  assert.deepEqual(result.poi, { poiId: 888, poiName: "云冈石窟" });
});

test("parseSuggestPoiPayload：顶层 poiList 形态", () => {
  const payload = {
    ResponseStatus: successAck(),
    poiList: [{ poiId: "555", poiName: " 兵马俑 " }],
  };
  const result = parseSuggestPoiPayload(payload);
  assert.deepEqual(result.poi, { poiId: 555, poiName: "兵马俑" });
});

test("parseSuggestPoiPayload：真实顶层 poiDtos/name 形态", () => {
  const payload = {
    ResponseStatus: successAck(),
    poiDtos: [
      { poiId: 83199, name: " 晋祠博物馆 ", countryId: 1 },
      { poiId: 120329235, name: "太原古县城景区", countryId: 1 },
    ],
  };
  const result = parseSuggestPoiPayload(payload);
  assert.deepEqual(result.poi, { poiId: 83199, poiName: "晋祠博物馆" });
});

test("parseSuggestPoiPlaces：poiDtos/name 与 data.poiDtos 均兼容，poiName 优先", () => {
  const topLevel = parseSuggestPoiPlaces({
    ResponseStatus: successAck(),
    poiDtos: [
      { poiId: 83199, name: "晋祠博物馆", countryId: 1 },
      { poiId: 0, name: "无效 POI" },
    ],
  });
  assert.deepEqual(topLevel.places, [{
    poiId: 83199,
    poiName: "晋祠博物馆",
    address: null,
    province: null,
    city: null,
    district: null,
  }]);

  const nested = parseSuggestPoiPlaces({
    ResponseStatus: successAck(),
    data: {
      poiDtos: [{ poiId: 42, poiName: "首选名称", name: "备用名称" }],
    },
  });
  assert.equal(nested.places[0]?.poiName, "首选名称");
});

test("parseSuggestPoiPayload：跳过缺 poiId / 缺 poiName 的候选，返回 null", () => {
  const payload = {
    ResponseStatus: successAck(),
    body: [
      { poiName: "无名" }, // 缺 poiId
      { poiId: 1 }, // 缺 poiName
      { poiId: 42, poiName: "正名" },
    ],
  };
  const result = parseSuggestPoiPayload(payload);
  assert.deepEqual(result.poi, { poiId: 42, poiName: "正名" });
});

test("parseSuggestPoiPayload：空列表 → poi null", () => {
  const result = parseSuggestPoiPayload({ ResponseStatus: successAck(), body: [] });
  assert.equal(result.poi, null);
});

test("parseSuggestPoiPayload：Ack 非 Success 抛错并附带错误描述", () => {
  const payload = {
    ResponseStatus: {
      Ack: "Failure",
      Errors: [{ Message: "登录态失效" }],
    },
    body: [],
  };
  assert.throws(() => parseSuggestPoiPayload(payload), /业务失败/);
  try {
    parseSuggestPoiPayload(payload);
  } catch (error) {
    assert.match((error as Error).message, /登录态失效/);
  }
});

// ─────────────────────────────────────────────────────────────────────────
// 4. parseSearchImagePayload：多种响应形态
// ─────────────────────────────────────────────────────────────────────────

test("parseSearchImagePayload：imageIds 直接形态", () => {
  const payload = {
    ResponseStatus: successAck(),
    imageIds: [1, 2, 3, 4, 5],
  };
  const result = parseSearchImagePayload(payload, 200);
  assert.equal(result.imageIds.length, 5);
  assert.deepEqual(result.imageIds, [1, 2, 3, 4, 5]);
});

test("parseSearchImagePayload：imageList 形态 + imageId 字段名变体", () => {
  const payload = {
    ResponseStatus: successAck(),
    imageList: [
      { imageId: 100 },
      { id: 200 },
      { picId: 300 },
      { image: { imageId: 400 } },
    ],
  };
  const result = parseSearchImagePayload(payload);
  assert.deepEqual(result.imageIds, [100, 200, 300, 400]);
});

test("parseSearchImagePayload：body 形态 + 字符串 imageId + 去重", () => {
  const payload = {
    ResponseStatus: successAck(),
    body: [
      { imageId: "11" },
      { imageId: 11 }, // 重复
      { imageId: 22 },
      { imageId: "not-a-number" },
      { imageId: -1 },
      { imageId: 0 },
      { imageId: 33 },
    ],
  };
  const result = parseSearchImagePayload(payload);
  assert.deepEqual(result.imageIds, [11, 22, 33]);
});

test("parseSearchImagePayload：data.imageIds 形态", () => {
  const payload = {
    ResponseStatus: successAck(),
    data: { imageIds: [7, 8, 9] },
  };
  const result = parseSearchImagePayload(payload);
  assert.deepEqual(result.imageIds, [7, 8, 9]);
});

test("parseSearchImagePayload：images 形态", () => {
  const payload = {
    ResponseStatus: successAck(),
    images: [{ imageId: 1 }, { imageId: 2 }],
  };
  const result = parseSearchImagePayload(payload);
  assert.deepEqual(result.imageIds, [1, 2]);
});

test("parseSearchImagePayload：空列表 → 空 imageIds 不抛错", () => {
  const result = parseSearchImagePayload({ ResponseStatus: successAck(), body: [] });
  assert.deepEqual(result.imageIds, []);
});

test("parseSearchImagePayload：Ack 非 Success 抛错", () => {
  const payload = {
    ResponseStatus: { Ack: "Failure", Errors: [{ Message: "POI 不存在" }] },
    body: [],
  };
  assert.throws(() => parseSearchImagePayload(payload), /业务失败/);
  try {
    parseSearchImagePayload(payload);
  } catch (error) {
    assert.match((error as Error).message, /POI 不存在/);
  }
});

// ─────────────────────────────────────────────────────────────────────────
// 6. endpoint 常量与超时常量
// ─────────────────────────────────────────────────────────────────────────

test("SUGGESTPOI_ENDPOINT / SEARCH_IMAGE_ENDPOINT 指向真实 VBK SOA 地址", () => {
  assert.equal(SUGGESTPOI_ENDPOINT, "https://online.ctrip.com/restapi/soa2/15638/suggestpoi.json");
  assert.equal(SEARCH_IMAGE_ENDPOINT, "https://online.ctrip.com/restapi/soa2/12719/searchImage");
});

test("默认超时常量大于 0", () => {
  assert.ok(CTRIP_LIBRARY_BROWSER_REQUEST_TIMEOUT_MS > 0);
  assert.ok(CTRIP_LIBRARY_EVALUATE_TIMEOUT_MS >= CTRIP_LIBRARY_BROWSER_REQUEST_TIMEOUT_MS);
});
