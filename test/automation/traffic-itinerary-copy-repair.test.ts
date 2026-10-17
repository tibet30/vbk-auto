import test from "node:test";
import assert from "node:assert/strict";
import {
  applyTrafficDetailCopyRewrite,
  findTrafficDetailCopyHits,
  isTrafficItineraryKeywordRejection,
  runTrafficItineraryCopyRepair,
  type TrafficLineCopyRepair,
} from "../../src/main/automation/ctrip/traffic-line/itinerary-copy-repair.js";
import { submitTrafficRouteReview } from "../../src/main/automation/ctrip/traffic-line/route-review.js";

const KEYWORD = "国宾";
const CHECK8_FAILURE = `校验子产品行程交通失败（Ack=Failure）：300019:保存第1天行程描述，提示非法关键词：${KEYWORD}，请修改后重新提交`;
const CHECK3_FAILURE = `保存子产品行程交通失败（Ack=Failure）：300019:保存第1天行程描述，提示非法关键词：${KEYWORD}，请修改后重新提交`;
const ROUTE_REVIEW_FAILURE = `线路匹配审核前行程校验失败（Ack=Failure）：300019:保存第1天行程描述，提示非法关键词：爱国主义教育，请修改后重新提交`;

function detail() {
  return {
    tourInfoId: 9100,
    tourDailyDescriptions: [
      {
        dailyDescription: "第一天 · 国宾级景区建筑群",
        subDesc: "含国宾接待标准说明",
        tourDailyInfos: [
          { activeType: { key: 14, name: "火车" }, title: "去程", tourDailyTrains: [{ trainNo: "C895" }] },
          { activeType: { key: 3, name: "景点" }, description: "参观国宾级景区建筑群", warmTips: "请勿喧哗", tourDailyPois: [{ poi: { poiId: 1, poiName: "国宾风景区" } }] },
        ],
      },
      { dailyDescription: "第二天", tourDailyInfos: [{ activeType: { key: 3, name: "景点" }, description: "自由活动" }] },
    ],
  };
}

function rewriter(strip = (value: string) => value.replaceAll(KEYWORD, "国家级")) {
  return async (request: { targets: Array<{ path: string; value: string }> }) => ({
    reply: "已改写",
    patch: request.targets.map((target) => ({ op: "replace" as const, path: target.path, value: strip(target.value) })),
    questions: [], researchTasks: [],
  });
}

test("只有子产品行程校验与线路审核前校验的 Ack 失败才算关键词驳回", () => {
  assert.equal(isTrafficItineraryKeywordRejection(CHECK8_FAILURE), true);
  assert.equal(isTrafficItineraryKeywordRejection(CHECK3_FAILURE), true);
  assert.equal(isTrafficItineraryKeywordRejection(ROUTE_REVIEW_FAILURE), true);
  assert.equal(isTrafficItineraryKeywordRejection("校验子产品行程交通失败（Ack=Failure）：缺少首日或末日目标交通节点"), true);
  assert.equal(isTrafficItineraryKeywordRejection("行程审核校验失败（Ack=Failure）：非法关键词：药浴"), false);
  assert.equal(isTrafficItineraryKeywordRejection("子产品行程交通保存后未生成 tourInfoId。"), false);
});

test("只定位自由文案字段，不改景点与交通实体身份", () => {
  assert.deepEqual(findTrafficDetailCopyHits(detail(), [KEYWORD]).map((target) => target.path), [
    "/tourDailyDescriptions/0/dailyDescription",
    "/tourDailyDescriptions/0/subDesc",
    "/tourDailyDescriptions/0/tourDailyInfos/1/description",
  ]);
  assert.deepEqual(findTrafficDetailCopyHits(detail(), ["国宾风景区"]), []);
  assert.deepEqual(findTrafficDetailCopyHits(detail(), ["C895"]), []);
});

test("只接受命中路径的 replace，并在整体校验后提交", () => {
  const value = detail();
  const paths = applyTrafficDetailCopyRewrite(value, {
    reply: "已改写",
    patch: [
      { op: "replace", path: "/tourDailyDescriptions/0/dailyDescription", value: "第一天 · 国家级景区建筑群" },
      { op: "replace", path: "/tourDailyDescriptions/0/subDesc", value: "含高规格接待说明" },
      { op: "replace", path: "/tourDailyDescriptions/0/tourDailyInfos/1/description", value: "参观国家级景区建筑群" },
    ],
    questions: [], researchTasks: [],
  }, [KEYWORD]);
  assert.deepEqual(paths, [
    "/tourDailyDescriptions/0/dailyDescription",
    "/tourDailyDescriptions/0/subDesc",
    "/tourDailyDescriptions/0/tourDailyInfos/1/description",
  ]);
  // POI 身份字段保留官方名称，只有自由文案被改写。
  assert.deepEqual(findTrafficDetailCopyHits(value, [KEYWORD]), []);
  assert.equal(value.tourDailyDescriptions[0].tourDailyInfos[1].tourDailyPois[0].poi.poiName, "国宾风景区");

  assert.throws(() => applyTrafficDetailCopyRewrite(detail(), {
    reply: "越权", patch: [{ op: "replace", path: "/tourDailyDescriptions/1/tourDailyInfos/0/description", value: "顺带改写" }],
    questions: [], researchTasks: [],
  }, [KEYWORD]), /只能 replace 命中的文案字段/);
  assert.throws(() => applyTrafficDetailCopyRewrite(detail(), {
    reply: "未改", patch: [{ op: "replace", path: "/tourDailyDescriptions/0/tourDailyInfos/1/description", value: "参观国宾级景区建筑群" }],
    questions: [], researchTasks: [],
  }, [KEYWORD]), /未重写命中的子产品行程文案字段/);
  assert.throws(() => applyTrafficDetailCopyRewrite(detail(), {
    reply: "残留", patch: [
      { op: "replace", path: "/tourDailyDescriptions/0/dailyDescription", value: "第一天 · 国家级景区建筑群" },
      { op: "replace", path: "/tourDailyDescriptions/0/subDesc", value: "含高规格接待说明" },
      { op: "replace", path: "/tourDailyDescriptions/0/tourDailyInfos/1/description", value: "参观国宾级景区" },
    ],
    questions: [], researchTasks: [],
  }, [KEYWORD]), /仍包含平台非法关键词/);
});

test("写前校验驳回时改写并重试，写入后失败不重试", async () => {
  const value = detail();
  const seen: Array<{ words: string[]; paths: string[] }> = [];
  const repair: TrafficLineCopyRepair = { rewrite: rewriter(), onRepaired: (info) => { seen.push({ words: [...info.words], paths: [...info.paths] }); } };
  let attempts = 0;
  const result = await runTrafficItineraryCopyRepair({
    detail: value,
    repair,
    execute: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error(CHECK8_FAILURE);
      return "saved";
    },
  });
  assert.equal(result, "saved");
  assert.equal(attempts, 2);
  assert.deepEqual(findTrafficDetailCopyHits(value, [KEYWORD]), []);
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0]!.words, [KEYWORD]);

  let wroteAttempts = 0;
  await assert.rejects(runTrafficItineraryCopyRepair({
    detail: detail(),
    repair,
    execute: async (markWrite) => { wroteAttempts += 1; markWrite(); throw new Error(CHECK8_FAILURE); },
  }), /非法关键词/);
  assert.equal(wroteAttempts, 1);
});

test("命中词无法定位或超出预算时如实上抛", async () => {
  const clean = { tourDailyDescriptions: [{ dailyDescription: "第一天", tourDailyInfos: [{ description: "自由活动" }] }] };
  await assert.rejects(runTrafficItineraryCopyRepair({
    detail: clean,
    repair: { rewrite: rewriter() },
    execute: async () => { throw new Error(CHECK8_FAILURE); },
  }), /没有可自动改写的命中文案字段/);

  await assert.rejects(runTrafficItineraryCopyRepair({
    detail: detail(),
    execute: async () => { throw new Error(CHECK8_FAILURE); },
  }), /未配置行程文案改写器/);

  // 平台每轮点名一个仍存在于本地的词：修复一次后用尽预算，必须上抛原始错误。
  const twoHits = {
    tourDailyDescriptions: [
      { dailyDescription: "第一天", tourDailyInfos: [{ activeType: { key: 3 }, description: `参观${KEYWORD}级景区建筑群` }] },
      { dailyDescription: "第二天", tourDailyInfos: [{ activeType: { key: 3 }, description: "爱国主义教育主题参访" }] },
    ],
  };
  const rejected = [KEYWORD, "爱国主义教育"];
  let attempts = 0;
  await assert.rejects(runTrafficItineraryCopyRepair({
    detail: twoHits,
    repair: { rewrite: rewriter() },
    maxRepairs: 1,
    execute: async () => {
      const word = rejected[Math.min(attempts, rejected.length - 1)]!;
      attempts += 1;
      throw new Error(`保存子产品行程交通失败（Ack=Failure）：300019:保存第1天行程描述，提示非法关键词：${word}，请修改后重新提交`);
    },
  }), /非法关键词：爱国主义教育/);
  assert.equal(attempts, 2);
});

test("线路匹配审核前校验被关键词驳回时改写后重试同一授权提交", async () => {
  const requests: Array<{ path: string; body: any }> = [];
  let reviewSubmitted = false;
  let checkCount = 0;
  const page = {
    async evaluate<T, A>(fn: (arg: A) => T | Promise<T>, arg: A) {
      const previousDocument = (globalThis as { document?: unknown }).document;
      const previousFetch = globalThis.fetch;
      (globalThis as { document?: { cookie: string } }).document = { cookie: "GUID=CID-VALUE" };
      globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
        const path = new URL(String(url)).pathname.split("/").pop() ?? "";
        const body = JSON.parse(String(init?.body ?? "{}"));
        requests.push({ path, body });
        const ok = (payload: unknown) => new Response(
          JSON.stringify({ ResponseStatus: { Ack: "Success", Errors: [] }, ...payload }), { status: 200 },
        );
        if (path === "getProductBaseInfo") {
          return ok({ baseInfo: { productId: 1, routeId: reviewSubmitted ? 40004141 : 0, routeMainTitle: reviewSubmitted ? "线路A" : "" } });
        }
        if (path === "getProductTourInfoList") {
          return ok({ tourInfos: [{ tourInfoId: 9100, main: true, sort: 0, days: 1,
            auditStatus: { key: reviewSubmitted ? "A" : "N" } }] });
        }
        if (path === "getTourDailyDetail.json") {
          return ok({ tourInfo: { tourInfoId: 9100, tourDailyDescriptions: [
            { orderDay: 1, dailyDescription: "第一天", tourDailyInfos: [
              { activeType: { key: 3, name: "景点" }, description: `参观${KEYWORD}级景区建筑群` },
            ] },
          ] } });
        }
        if (path === "checkTourDaily") {
          checkCount += 1;
          if (checkCount === 1) {
            return new Response(JSON.stringify({ ResponseStatus: { Ack: "Failure", Errors: [
              { ErrorCode: "50016002", Message: `300019:保存第1天行程描述，提示非法关键词：${KEYWORD}，请修改后重新提交` },
            ] } }), { status: 200 });
          }
          return ok({ tourDaily: body.tourDaily });
        }
        if (path === "saveTourDailyDetail.json") return ok({ tourInfoId: 9100 });
        if (path === "saveProductTourInfo") { reviewSubmitted = true; return ok({}); }
        throw new Error(`unexpected path ${path}`);
      }) as typeof fetch;
      try {
        return await fn(arg);
      } finally {
        globalThis.fetch = previousFetch;
        if (previousDocument === undefined) delete (globalThis as { document?: unknown }).document;
        else (globalThis as { document?: unknown }).document = previousDocument;
      }
    },
  };
  const seen: string[] = [];
  const result = await submitTrafficRouteReview(page as never, "1", {
    authorization: "submit-route-review",
    copyRepair: { rewrite: rewriter(), onRepaired: (info) => { seen.push(...info.paths); } },
  });
  assert.equal(result.verified, true);
  assert.equal(checkCount, 2);
  assert.deepEqual(seen, ["/tourDailyDescriptions/0/tourDailyInfos/0/description"]);
  const checks = requests.filter((request) => request.path === "checkTourDaily");
  assert.equal(String(checks[0]!.body.tourDaily).includes(KEYWORD), true);
  assert.equal(String(checks[1]!.body.tourDaily).includes(KEYWORD), false);
  assert.equal(requests.filter((request) => request.path === "saveProductTourInfo").length, 1);
  assert.equal(requests.filter((request) => request.path === "saveTourDailyDetail.json").length, 1);
});
