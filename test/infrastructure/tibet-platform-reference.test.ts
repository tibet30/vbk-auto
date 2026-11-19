import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPlatformReference,
  normalizePlaceName,
  titleGrams,
  titleSimilarity,
} from "../../src/main/infrastructure/tibet-platform-reference.js";
import {
  TibetServiceScopeError,
  type TibetCatalogService,
  type TibetServiceClient,
} from "../../src/main/infrastructure/tibet-service-client.js";

function service(overrides: Partial<TibetCatalogService> = {}): TibetCatalogService {
  return {
    publicId: "172708729898149707",
    title: "成都青城山都江堰私家团两日游",
    subtitle: null,
    countryCode: "cn",
    cityCode: "chengdu",
    serviceType: "private_tour",
    durationLabel: "2天1晚",
    priceFrom: 1200,
    availableLabel: "天天出发",
    tags: [],
    hot: false,
    ...overrides,
  };
}

function client(options: {
  services?: TibetCatalogService[];
  cities?: { code: string; name: string }[];
  configured?: boolean;
  onQuery?: (query: { city?: string; search?: string }) => void;
}): TibetServiceClient {
  return {
    configured: () => options.configured ?? true,
    selfCheck: async () => { throw new Error("unused"); },
    listServices: async (query = {}) => {
      options.onQuery?.({ city: query.city, search: query.search });
      return { items: options.services ?? [], total: (options.services ?? []).length, page: 1, pageSize: 20 };
    },
    getService: async () => { throw new Error("unused"); },
    listAdminServices: async () => ({ items: [], total: 0, page: 1, pageSize: 20 }),
    listDictionaries: async () => (options.cities ?? [{ code: "chengdu", name: "成都" }]).map((city) => ({
      type: "city", code: city.code, name: city.name,
    })),
    listVbkBindings: async () => ({ items: [], activeVbkAccountKey: null }),
    listOrders: async () => [],
    getOrder: async () => { throw new Error("unused"); },
  };
}

test("城市名归一化：只去掉「市」尾缀，不能把「州/区/县」削掉", () => {
  assert.equal(normalizePlaceName(" 成都市 "), "成都");
  assert.equal(normalizePlaceName("日喀则市"), "日喀则");
  assert.equal(normalizePlaceName("广州"), "广州", "广州不能被削成广");
  assert.equal(normalizePlaceName("兰州"), "兰州");
  assert.equal(normalizePlaceName(undefined), "");
});

test("标题相似度：相同玩法高相似，不同玩法低相似", () => {
  const similar = titleSimilarity("成都青城山都江堰私家团两日游", "成都青城山都江堰两日私家团");
  assert.ok(similar > 0.6, `应高度相似，实际 ${similar}`);
  const different = titleSimilarity("成都青城山都江堰私家团两日游", "三亚潜水一日游");
  assert.ok(different < 0.2, `应明显不同，实际 ${different}`);
  assert.equal(titleSimilarity("", "任意"), 0);
  assert.deepEqual([...titleGrams("2天1晚")], [], "纯数字不参与相似度");
});

test("同城 + 相似标题命中，并给出与产品成人价的差价", async () => {
  const queries: { city?: string; search?: string }[] = [];
  const result = await buildPlatformReference(client({
    services: [service()],
    onQuery: (query) => queries.push(query),
  }), {
    title: "成都青城山都江堰私家团两日游",
    meetingCity: "成都",
    days: 2,
    adultPrice: 1000,
  });

  assert.equal(result.configured, true);
  assert.deepEqual(result.query.cityCodes, ["chengdu"], "中文城市名要能映射成平台 code");
  assert.ok(queries.some((query) => query.city === "chengdu"), "必须按城市查询");
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].priceFrom, 1200);
  assert.equal(result.matches[0].priceGap, 200);
  assert.ok(result.matches[0].reasons.includes("同城"));
  assert.match(result.message, /仅供参考/u);
});

test("同城但玩法不同不硬凑；跨城只靠标题相似度", async () => {
  const result = await buildPlatformReference(client({
    services: [
      service({ publicId: "909223317350627981", title: "成都火锅半日美食体验", priceFrom: 300 }),
      service({ publicId: "372737529831807050", title: "成都青城山都江堰私家团两日游", cityCode: "chongqing", priceFrom: 1180 }),
    ],
  }), { title: "成都青城山都江堰私家团两日游", meetingCity: "成都", adultPrice: null });

  const ids = result.matches.map((match) => match.publicId);
  assert.equal(ids.includes("909223317350627981"), false, "同城但玩法不同不应命中");
  assert.equal(ids.includes("372737529831807050"), true, "跨城但标题高度相似应命中");
});

test("没有命中时如实说明，不给空壳结论", async () => {
  const result = await buildPlatformReference(client({ services: [] }), {
    title: "成都青城山都江堰私家团两日游",
    meetingCity: "成都",
  });
  assert.equal(result.matches.length, 0);
  assert.match(result.message, /没有找到/u);
  assert.match(result.message, /成都/u);
});

test("未配置令牌时不发请求，说明无法比对", async () => {
  let called = false;
  const result = await buildPlatformReference(client({
    configured: false,
    services: [service()],
    onQuery: () => { called = true; },
  }), { title: "成都青城山都江堰私家团两日游", meetingCity: "成都" });
  assert.equal(result.configured, false);
  assert.equal(result.matches.length, 0);
  assert.equal(called, false, "未配置令牌不该发请求");
  assert.match(result.message, /未配置/u);
});

test("缺身份（403）继续抛出，不被当成「没有同类服务」", async () => {
  const denied = client({ services: [service()] });
  denied.listServices = async () => { throw new TibetServiceScopeError("该服务令牌未绑定身份"); };
  await assert.rejects(
    () => buildPlatformReference(denied, { title: "成都青城山都江堰私家团两日游", meetingCity: "成都" }),
    /未绑定身份/u,
  );
});

test("产品没有标题时不猜，直接说明", async () => {
  const result = await buildPlatformReference(client({ services: [service()] }), { title: "   ", meetingCity: "成都" });
  assert.equal(result.matches.length, 0);
  assert.match(result.message, /还没有标题/u);
});
