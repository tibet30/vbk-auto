import test from "node:test";
import assert from "node:assert/strict";
import { ensureTrafficLineItinerary } from "../../src/main/automation/ctrip/traffic-line/itinerary.js";
import type { TrafficLineCopyRepair } from "../../src/main/automation/ctrip/traffic-line/itinerary-copy-repair.js";

const KEYWORD = "国宾";
const CHILD_ID = "78350600";
const TOUR_INFO_ID = 9100;

/** 与真实线上一致：平台在写前校验里点名「第N天行程描述」的非法关键词。 */
function keywordRejection(label: string) {
  return {
    ResponseStatus: { Ack: "Failure", Errors: [
      { ErrorCode: "50016002", Message: `300019:保存第1天行程描述，提示非法关键词：${KEYWORD}，请修改后重新提交（${label}）` },
    ] },
  };
}

function trainNode(title: string) {
  return { activeType: { key: 14, name: "火车" }, title, tourDailyPackageTrains: [{ trainNo: "C895" }], tourDailyTrains: [] };
}

/**
 * 子产品行程交通写链夹具：首末日交通节点来自编辑页 initial state，
 * 行程详情里带一份含非法关键词的景点描述。
 */
function fixture(options: { rejectCheck8?: boolean; rejectSaveDetail?: boolean } = {}) {
  const requests: Array<{ path: string; body: any }> = [];
  let check8Count = 0;
  let check3Count = 0;
  let savedDetail: any = {
    tourInfoId: TOUR_INFO_ID,
    tourDailyDescriptions: [
      { dailyDescription: "第一天", tourDailyInfos: [
        { activeType: { key: 3, name: "景点" }, description: `参观${KEYWORD}级景区建筑群`, tourDailyPois: [{ poi: { poiId: 1 } }] },
      ] },
      { dailyDescription: "第二天", tourDailyInfos: [
        { activeType: { key: 3, name: "景点" }, description: "自由活动", tourDailyPois: [{ poi: { poiId: 2 } }] },
      ] },
    ],
  };
  const parentHtml = `<script>window.__INITIAL_STATE__ = ${JSON.stringify({
    dailyContext: { tourDailyDescriptions: [
      { tourDailyInfos: [trainNode("去程")] }, { tourDailyInfos: [trainNode("回程")] },
    ] },
  })};</script>`;
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
        const failure = (payload: unknown) => new Response(JSON.stringify(payload), { status: 200 });
        if (path === "getProductTourInfoList") {
          return ok({ tourInfos: [{ tourInfoId: TOUR_INFO_ID, main: true, sort: 0, days: 2 }] });
        }
        if (path === "getTourDailyDetail.json") return ok({ tourInfo: structuredClone(savedDetail) });
        if (path === "checkTourDaily") {
          if (body.saveType === 8) {
            check8Count += 1;
            if (options.rejectCheck8 && check8Count === 1) return failure(keywordRejection("check8"));
            return ok({ tourDaily: body.tourDaily });
          }
          check3Count += 1;
          savedDetail = JSON.parse(body.tourDaily);
          return ok({ tourDaily: body.tourDaily });
        }
        if (path === "calculateTourInfoScore") return ok({ tourInfo: { aggregateScore: 100, tourInfoScores: [] } });
        if (path === "saveTourDailyDetail.json") {
          if (options.rejectSaveDetail) return failure(keywordRejection("saveDaily"));
          return ok({ tourInfoId: TOUR_INFO_ID });
        }
        if (path === "saveProductTourInfo") return ok({});
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
    vbkSessionGetSessionText: async () => ({ status: 200, text: parentHtml }),
    vbkSessionGetText: async () => ({ status: 200, text: parentHtml }),
  };
  return {
    page,
    requests,
    get check8Count() { return check8Count; },
    get check3Count() { return check3Count; },
    get savedDetail() { return savedDetail; },
  };
}

function repair(seen: { words: string[]; paths: string[] }[]): TrafficLineCopyRepair {
  return {
    rewrite: async (request) => ({
      reply: "已改写",
      patch: request.targets.map((target) => ({
        op: "replace" as const,
        path: target.path,
        value: target.value.replaceAll(KEYWORD, "国家级"),
      })),
      questions: [], researchTasks: [],
    }),
    onRepaired: ({ words, paths }) => { seen.push({ words: [...words], paths: [...paths] }); },
  };
}

test("子产品行程校验被平台以非法关键词驳回时，自动改写命中文案并重试成功", async () => {
  const f = fixture({ rejectCheck8: true });
  const seen: Array<{ words: string[]; paths: string[] }> = [];
  const result = await ensureTrafficLineItinerary(f.page as never, CHILD_ID, "trainRoundTrip", undefined, repair(seen));

  assert.equal(result.days, 2);
  assert.equal(f.check8Count, 2, "第一次校验被驳回后必须重试一次");
  assert.equal(f.check3Count, 1);
  assert.deepEqual(seen, [{ words: [KEYWORD], paths: ["/tourDailyDescriptions/0/tourDailyInfos/1/description"] }]);
  const checks = f.requests.filter((request) => request.path === "checkTourDaily");
  const firstTourDaily = checks[0]!.body.tourDaily as string;
  const secondTourDaily = checks[1]!.body.tourDaily as string;
  assert.equal(firstTourDaily.includes(KEYWORD), true);
  assert.equal(secondTourDaily.includes(KEYWORD), false, "重试的校验载荷必须已清掉平台点名的词");
  assert.equal(secondTourDaily.includes("国家级"), true);
  assert.equal(f.savedDetail.tourDailyDescriptions[0].tourDailyInfos[1].description.includes(KEYWORD), false);
  assert.deepEqual(
    f.requests.filter((request) => request.path === "saveTourDailyDetail.json").length, 1,
  );
});

test("已发生远端写入后的关键词失败不自动重试，保持原有失败语义", async () => {
  const f = fixture({ rejectCheck8: true, rejectSaveDetail: true });
  const seen: Array<{ words: string[]; paths: string[] }> = [];
  await assert.rejects(
    () => ensureTrafficLineItinerary(f.page as never, CHILD_ID, "trainRoundTrip", undefined, repair(seen)),
    /非法关键词：国宾/,
  );
  assert.equal(seen.length, 1, "写前校验驳回仍会修复一次");
  assert.equal(f.check8Count, 2);
  assert.equal(f.check3Count, 1);
  assert.deepEqual(f.requests.filter((request) => request.path === "saveProductTourInfo"), []);
});

test("没有配置改写能力时如实上抛平台错误且不写入", async () => {
  const f = fixture({ rejectCheck8: true });
  await assert.rejects(
    () => ensureTrafficLineItinerary(f.page as never, CHILD_ID, "trainRoundTrip"),
    /非法关键词：国宾/,
  );
  assert.equal(f.check8Count, 1);
  assert.equal(f.requests.some((request) => request.path === "saveTourDailyDetail.json"), false);
  assert.equal(f.requests.some((request) => request.path === "saveProductTourInfo"), false);
});

test("平台未驳回时保持原有一次校验与写入行为", async () => {
  const f = fixture();
  const seen: Array<{ words: string[]; paths: string[] }> = [];
  const result = await ensureTrafficLineItinerary(f.page as never, CHILD_ID, "trainRoundTrip", undefined, repair(seen));
  assert.equal(result.days, 2);
  assert.equal(f.check8Count, 1);
  assert.equal(f.check3Count, 1);
  assert.deepEqual(seen, []);
  assert.equal(f.requests.filter((request) => request.path === "saveTourDailyDetail.json").length, 1);
});
