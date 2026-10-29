import test from "node:test";
import assert from "node:assert/strict";
import { needsTrafficLineBackfill } from "../../src/main/automation/traffic-line-backfill.js";
import type { ProductDetail } from "../../src/shared/contracts.js";
import { readFileSync } from "node:fs";
import { ensureTrafficLineItinerary } from "../../src/main/automation/ctrip/traffic-line/itinerary.js";
import { readParentItineraryForChild, rebaseOnParentDescriptions } from "../../src/main/automation/ctrip/traffic-line/itinerary/parent-sync.js";

test("已保存母草稿补回已核验交通计划后只需补交通阶段", () => {
  const product = {
    productId: "79141894",
    automation: { status: "succeeded", phases: [
      { phase: "basic", status: "completed" },
      { phase: "terms", status: "completed" },
      { phase: "preflight", status: "completed" },
    ] },
    product: {
      sales: { productForm: "privateTour" },
      itinerary: [],
      operations: { trafficLine: { enabled: true, variants: ["flightRoundTrip", "trainRoundTrip"] } },
    },
  } as unknown as ProductDetail;
  assert.equal(needsTrafficLineBackfill(product), true);
  product.automation!.phases.push({ phase: "trafficLine", status: "completed" } as never);
  assert.equal(needsTrafficLineBackfill(product), true);
  product.automation!.trafficLine = { children: ["flightRoundTrip", "trainRoundTrip"].map(variant => ({ variant, verified: true, completedStages: ["finalReadback"] })) } as any;
  assert.equal(needsTrafficLineBackfill(product), false);
});


test("母产品成功但交通失败时只恢复交通，其他失败仍不得绕过", () => {
  const product = { productId: "79313974", product: { operations: { trafficLine: { enabled: true, variants: ["flightRoundTrip"] } } },
    automation: { status: "succeeded", phases: [
      { phase: "basic", status: "completed" }, { phase: "trafficLine", status: "failed" }, { phase: "preflight", status: "completed" },
    ] } } as unknown as ProductDetail;
  assert.equal(needsTrafficLineBackfill(product), true);
  product.automation!.phases[0]!.status = "failed";
  assert.equal(needsTrafficLineBackfill(product), false);
});

test("已跳过的异步校验失败仍恢复现有子产品，资源确实不可用则不重跑", () => {
  const product = { productId: "79341474", product: { operations: { trafficLine: {
    enabled: true, variants: ["flightRoundTrip"],
  } } }, automation: { status: "succeeded", phases: [
    { phase: "basic", status: "completed" }, { phase: "trafficLine", status: "completed" },
    { phase: "preflight", status: "completed" },
  ], trafficLine: { children: [{ variant: "flightRoundTrip", childProductId: "79341666",
    completedStages: ["childCreated"], verified: false, skipped: true,
    failureReason: "子产品资源提交仍在 VBK 异步核验",
  }] } } } as unknown as ProductDetail;
  assert.equal(needsTrafficLineBackfill(product), true);
  const child = product.automation!.trafficLine!.children[0]!;
  child.failureReason = "没有任何可用的多出发城市";
  assert.equal(needsTrafficLineBackfill(product), false);
  child.failureReason = undefined;
  child.verified = true;
  child.completedStages.push("finalReadback");
  assert.equal(needsTrafficLineBackfill(product), false);
});


test("交通阶段网络失败且尚无子产品时不能借母产品成功结案", () => {
  const product = { productId: "parent", product: { operations: { trafficLine: { enabled: true, variants: ["flightRoundTrip", "trainRoundTrip"] } } }, automation: { status: "succeeded", phases: [{ phase: "trafficLine", status: "completed" }, { phase: "preflight", status: "completed" }], trafficLine: { children: [], failureReason: "net::ERR_FAILED" } } } as unknown as ProductDetail;
  assert.equal(needsTrafficLineBackfill(product), true);
});

const PARENT_ID = "79500001";
const CHILD_ID = "79500002";

function trainNode(title: string) {
  return { activeType: { key: 14, name: "火车" }, title, tourDailyPackageTrains: [{ trainNo: "C895" }], tourDailyTrains: [] };
}
function spotDay(title: string, poiId: number) {
  return { tourDailyDescriptionId: 1000 + poiId, dailyDescription: title,
    tourDailyInfos: [{ tourDailyInfoId: 2000 + poiId, activeType: { key: 3, name: "景点" }, description: title, tourDailyPois: [{ poi: { poiId } }] }] };
}

/** 母产品已改成 3 天、子产品仍是 2 天的只读/写入夹具；不触网。 */
function parentChildFixture() {
  const requests: Array<{ path: string; body: any }> = [];
  const parentDays = [spotDay("母D1", 1), spotDay("母D2", 2), spotDay("母D3", 3)];
  let childDetail: any = { tourInfoId: 9200, tourDailyDescriptions: [spotDay("子D1", 11), spotDay("子D2", 12)] };
  const childHtml = `<script>window.__INITIAL_STATE__ = ${JSON.stringify({ dailyContext: { tourDailyDescriptions: [
    { tourDailyInfos: [trainNode("去程")] }, { tourDailyInfos: [trainNode("回程")] },
  ] } })};</script>`;
  const page = {
    async evaluate<T, A>(fn: (arg: A) => T | Promise<T>, arg: A) {
      const previousDocument = (globalThis as { document?: unknown }).document;
      const previousFetch = globalThis.fetch;
      (globalThis as { document?: { cookie: string } }).document = { cookie: "GUID=CID-VALUE" };
      globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
        const path = new URL(String(url)).pathname.split("/").pop() ?? "";
        const body = JSON.parse(String(init?.body ?? "{}"));
        requests.push({ path, body });
        const ok = (payload: unknown) => new Response(JSON.stringify({ ResponseStatus: { Ack: "Success", Errors: [] }, ...payload as object }), { status: 200 });
        if (path === "getProductTourInfoList") {
          return ok({ tourInfos: [String(body.productId) === PARENT_ID
            ? { productId: Number(PARENT_ID), tourInfoId: 9100, draftTourInfoId: 9101, main: true, sort: 0, days: 3 }
            : { productId: Number(CHILD_ID), tourInfoId: 9200, main: true, sort: 0, days: childDetail.tourDailyDescriptions.length }] });
        }
        if (path === "getTourDailyDetail.json") {
          return ok({ tourInfo: body.tourInfoId === "9101" ? { tourInfoId: 9101, tourDailyDescriptions: parentDays } : structuredClone(childDetail) });
        }
        if (path === "checkTourDaily") {
          if (body.saveType === 3) childDetail = JSON.parse(body.tourDaily);
          return ok({ tourDaily: body.tourDaily });
        }
        if (path === "calculateTourInfoScore") return ok({ tourInfo: { aggregateScore: 100, tourInfoScores: [] } });
        if (path === "saveTourDailyDetail.json") return ok({ tourInfoId: 9200 });
        if (path === "saveProductTourInfo") return ok({});
        throw new Error(`unexpected path ${path}`);
      }) as typeof fetch;
      try { return await fn(arg); } finally {
        globalThis.fetch = previousFetch;
        if (previousDocument === undefined) delete (globalThis as { document?: unknown }).document;
        else (globalThis as { document?: unknown }).document = previousDocument;
      }
    },
    vbkSessionGetSessionText: async () => ({ status: 200, text: childHtml }),
    vbkSessionGetText: async () => ({ status: 200, text: childHtml }),
  };
  return { page, requests, get childDetail() { return childDetail; } };
}

test("子产品天数与母产品不同：按母产品每日行程重建子产品行程并合并首末交通节点", async () => {
  const f = parentChildFixture();
  const parentSync = await readParentItineraryForChild(f.page as never, PARENT_ID, CHILD_ID);
  assert.equal(parentSync?.descriptions.length, 3);
  assert.equal(parentSync?.childDays, 2, "返回子产品同步前的旧天数");
  const parentDescriptions = parentSync?.descriptions;
  assert.equal(f.requests.some((request) => request.path !== "getProductTourInfoList" && request.path !== "getTourDailyDetail.json"), false,
    "比较天数必须只读");
  const result = await ensureTrafficLineItinerary(f.page as never, CHILD_ID, "trainRoundTrip", undefined, undefined, parentDescriptions);
  assert.equal(result.days, 3);
  const days = f.childDetail.tourDailyDescriptions;
  assert.deepEqual(days.map((day: any) => day.dailyDescription), ["母D1", "母D2", "母D3"]);
  assert.deepEqual(days.map((day: any) => day.orderDay), [1, 2, 3]);
  assert.equal(days[0].tourDailyDescriptionId, null, "母产品版本引用 ID 必须清空");
  assert.ok(days[0].tourDailyInfos.some((node: any) => node.activeType?.key === 14), "首日合并去程交通");
  assert.ok(days[2].tourDailyInfos.some((node: any) => node.activeType?.key === 14), "末日合并回程交通");
  // 天数已一致时不再同步，子产品已生效分支照常提前返回。
  assert.equal(await readParentItineraryForChild(f.page as never, PARENT_ID, CHILD_ID), undefined);
});

test("天数不一致时已生效子产品不走提前 return", () => {
  const source = readFileSync(new URL("../../src/main/automation/ctrip/traffic-line/main/process-target.ts", import.meta.url), "utf8");
  const read = source.indexOf("readParentItineraryForChild(page, parentProductId, relationship.productId)");
  const early = source.indexOf("if (!parentDescriptions && relationship.active === true)");
  assert.ok(read > 0 && early > read, "必须先比较母子天数，再决定是否提前返回");
});

test("母产品含主题/航班节点时，所有 tourDaily*Id 与版本引用 ID 递归清空，其余字段保留", () => {
  const parentDays = [{ tourDailyDescriptionId: 1, orderDay: 1, refId: "r", parentId: 7, dailyDescription: "母D1",
    tourDailyInfos: [
      { tourDailyInfoId: 11, tourInfoId: 900, pkgTourInfoId: 901, activeType: { key: 1, name: "主题" },
        tourDailyTheme: { tourDailyThemeId: 21, themeName: "古城" } },
      { tourDailyInfoId: 12, activeType: { key: 14, name: "航班" },
        tourDailyFlight: { tourDailyFlightId: 31, flightNo: "MU1" }, tourDailyPackageFlightId: 32,
        tourDailyPois: [{ tourDailyPoiId: 41, poi: { poiId: 5001 } }] },
    ] }];
  const rebased = rebaseOnParentDescriptions({ tourInfoId: 9200, templateId: 3 }, parentDays);
  const [day] = rebased.tourDailyDescriptions as any[];
  assert.equal(rebased.tourInfoId, 9200, "子产品自身 tourInfo 不受影响");
  assert.deepEqual([day.tourDailyDescriptionId, day.refId, day.parentId], [null, null, null]);
  const [theme, flight] = day.tourDailyInfos;
  assert.deepEqual([theme.tourDailyInfoId, theme.tourInfoId, theme.pkgTourInfoId, theme.tourDailyTheme.tourDailyThemeId], [null, null, null, null]);
  assert.deepEqual([flight.tourDailyInfoId, flight.tourDailyFlight.tourDailyFlightId, flight.tourDailyPackageFlightId, flight.tourDailyPois[0].tourDailyPoiId], [null, null, null, null]);
  assert.equal(theme.tourDailyTheme.themeName, "古城");
  assert.equal(flight.tourDailyFlight.flightNo, "MU1");
  assert.equal(flight.tourDailyPois[0].poi.poiId, 5001, "POI 等业务 ID 保留");
  assert.equal(parentDays[0]!.tourDailyInfos[0]!.tourDailyInfoId, 11, "不改动母产品原数据");
});
