import assert from "node:assert/strict";
import test from "node:test";
import type { ProductDetail } from "../../src/shared/contracts.js";
import { completeDatedRoute, datedRouteDetailError, projectDatedRoute } from "../../src/main/planning/dated-route-projection.js";
import { routeFingerprint } from "../../src/main/planning/daily-route-structure.js";
import { mergedDailyRouteSources } from "../../src/main/agent/daily-route-source.js";
import { constraintUserIdea } from "../../src/shared/product-idea-optimization.js";

/** 真实事故样本：运营删除第 2 天「阿咪东索景区」、把第 4 天两景点改成「其他」后继续执行。 */
function product(overrides: Record<string, unknown> = {}): ProductDetail {
  return {
    id: "91660656-5d87-4adc-9760-c8ea361bdc3a",
    name: "西宁4天3晚自由行",
    status: "planning",
    product: {
      basicInfo: {
        supplierProductName: "西宁4天3晚自由行",
        days: 4,
        nights: 3,
        meetingCity: "西宁",
        destinationCity: "西宁",
        province: "青海",
        userIdea: [
          "D1：西宁 — 仙米国家森林公园 — 达坂山观景台 | 宿门源",
          "D2：门源 — 岗什卡雪峰 — 阿咪东索景区 | 宿祁连",
          "D3：祁连 — 祁连 9 号公路 — 祁连黑河源 | 宿肃南",
          "D4：祁连 — 巴尔斯雪山 - 七彩丹霞 | 张掖结束行程",
        ].join("\n"),
      },
      itinerary: [
        { day: 1, spots: [{ name: "仙米国家森林公园" }], hotelCity: "门源" },
        { day: 2, spots: [{ name: "岗什卡雪峰" }], hotelCity: "祁连" },
        { day: 3, spots: [{ name: "祁连 9 号公路" }], hotelCity: "肃南" },
        { day: 4, spots: [{ name: "巴尔斯雪山", kind: "other" }, { name: "七彩丹霞", kind: "other" }], hotelCity: undefined },
      ],
      manualReview: {
        itinerarySpotRemovals: [{ day: 2, name: "阿咪东索景区", removedAt: "2026-11-13T07:15:19.524Z" }],
        itinerarySpotKinds: [
          { day: 4, name: "巴尔斯雪山", kind: "other", setAt: "2026-11-13T07:15:30.000Z" },
          { day: 4, name: "七彩丹霞", kind: "other", setAt: "2026-11-13T07:15:36.000Z" },
        ],
      },
      ...overrides,
    },
    messages: [],
    researchTasks: [],
  } as unknown as ProductDetail;
}

const itinerary = (days: Array<{ day: number; title: string; description: string; spots: Array<{ name: string }> }>) =>
  days.map((day) => ({ ...day, hotel: "平台酒店", meals: "自理" }));

test("原始路线里的「| 宿X」不再被当作必须保留的景点节点", () => {
  const rows = completeDatedRoute(product())!;
  assert.deepEqual(rows[1]!.names, ["门源", "岗什卡雪峰", "阿咪东索景区"]);
  assert.deepEqual(rows[3]!.names, ["祁连", "巴尔斯雪山", "七彩丹霞"]);
});

test("运营删除的景点与改成其他的条目不再被原路线校验判为缺失", () => {
  const next = itinerary([
    { day: 1, title: "仙米国家森林公园", description: "西宁 — 仙米国家森林公园 — 达坂山观景台 | 宿门源", spots: [{ name: "仙米国家森林公园" }] },
    { day: 2, title: "岗什卡雪峰", description: "当晚按原路线住祁连。", spots: [{ name: "岗什卡雪峰" }] },
    { day: 3, title: "祁连 9 号公路", description: "祁连 — 祁连 9 号公路 — 祁连黑河源 | 宿肃南", spots: [{ name: "祁连 9 号公路" }] },
    { day: 4, title: "张掖散团", description: "当天从祁连出发，张掖结束行程。", spots: [{ name: "巴尔斯雪山" }, { name: "七彩丹霞" }] },
  ]);
  assert.equal(datedRouteDetailError(product(), next), undefined);
});

test("未结算的景点仍然必须保留，修复不放宽原路线校验", () => {
  const next = itinerary([
    { day: 1, title: "仙米国家森林公园", description: "西宁 — 仙米国家森林公园 — 达坂山观景台 | 宿门源", spots: [{ name: "仙米国家森林公园" }] },
    { day: 2, title: "门源出发", description: "门源 — 阿咪东索景区 | 宿祁连", spots: [] },
    { day: 3, title: "祁连 9 号公路", description: "祁连 — 祁连 9 号公路 — 祁连黑河源 | 宿肃南", spots: [{ name: "祁连 9 号公路" }] },
    { day: 4, title: "张掖散团", description: "祁连 — 巴尔斯雪山 - 七彩丹霞", spots: [{ name: "巴尔斯雪山" }, { name: "七彩丹霞" }] },
  ]);
  assert.equal(datedRouteDetailError(product(), next), "第 2 天未保留用户原始路线安排「岗什卡雪峰」。");
});

test("历史数据用核查任务的 no-poi 证据豁免被改成其他的条目", () => {
  const base = product() as unknown as { product: Record<string, unknown> };
  base.product.manualReview = {
    itinerarySpotRemovals: [{ day: 2, name: "阿咪东索景区", removedAt: "2026-11-13T07:15:19.524Z" }],
  };
  const legacy = base as unknown as ProductDetail;
  legacy.researchTasks = [{
    id: "t1", label: "核查 巴尔斯雪山 的 VBK POI 映射", type: "vbk", status: "queued", state: "researching",
    evidence: [{ id: "e1", title: "[itinerary-kind:no-poi] 当前条目明确为自由活动或其他，无需 POI 核查", source: "user", retrievedAt: "2026-11-13T07:15:30.000Z", accepted: true }],
  }];
  const next = itinerary([
    { day: 1, title: "仙米国家森林公园", description: "西宁 — 仙米国家森林公园 — 达坂山观景台 | 宿门源", spots: [{ name: "仙米国家森林公园" }] },
    { day: 2, title: "岗什卡雪峰", description: "门源 — 岗什卡雪峰 | 宿祁连", spots: [{ name: "岗什卡雪峰" }] },
    { day: 3, title: "祁连 9 号公路", description: "祁连 — 祁连 9 号公路 — 祁连黑河源 | 宿肃南", spots: [{ name: "祁连 9 号公路" }] },
    { day: 4, title: "张掖散团", description: "祁连 — 七彩丹霞", spots: [{ name: "七彩丹霞" }] },
  ]);
  assert.equal(datedRouteDetailError(legacy, next), undefined);
});

test("完整路线投影的住宿城市优先取 AI 读出的住宿地，无结构时交给下游兜底", () => {
  const withStructure = product() as unknown as Record<string, any>;
  const idea = withStructure.product.basicInfo.userIdea as string;
  withStructure.product.diagnostics = { dailyRouteStructure: {
    version: 2,
    fingerprint: routeFingerprint(mergedDailyRouteSources(constraintUserIdea(withStructure.product.basicInfo))),
    days: [
      { day: 1, nodes: [], overnight: { name: "门源" } },
      { day: 2, nodes: [], overnight: { name: "祁连" } },
      { day: 3, nodes: [], overnight: { name: "肃南" } },
      { day: 4, nodes: [] },
    ],
  } };
  const rows = projectDatedRoute(withStructure as unknown as ProductDetail)!;
  assert.deepEqual(rows.map(row => row.hotelCity), ["门源", "祁连", "肃南", undefined]);
  const plain = projectDatedRoute(product())!;
  assert.deepEqual(plain.map(row => row.hotelCity), [undefined, undefined, undefined, undefined], "没有 AI 结构时不写住宿城市，保持原兜底");
  assert.equal(typeof idea, "string");
});

test("完整路线的节点名优先用 AI 结构，不再按分隔符自己切词", () => {
  const idea = "D1：西宁 — 塔尔寺、八瓣莲花山 — 日月山 | 宿湟中\nD2：湟中 — 青海湖 — 西宁";
  const detail = { id: "x", name: "x", status: "planning", messages: [], researchTasks: [],
    product: { basicInfo: { days: 2, nights: 1, meetingCity: "西宁", destinationCity: "西宁", province: "青海", userIdea: idea }, itinerary: [] } } as unknown as ProductDetail;
  const structured = structuredClone(detail) as unknown as Record<string, any>;
  structured.product.diagnostics = { dailyRouteStructure: { version: 2,
    fingerprint: routeFingerprint(mergedDailyRouteSources(constraintUserIdea(structured.product.basicInfo))),
    days: [
      { day: 1, nodes: [{ name: "西宁", kind: "place" }, { name: "塔尔寺", kind: "attraction" },
        { name: "八瓣莲花山", kind: "attraction" }, { name: "日月山", kind: "attraction" }], overnight: { name: "湟中" } },
      { day: 2, nodes: [{ name: "湟中", kind: "place" }, { name: "青海湖", kind: "attraction" }, { name: "西宁", kind: "place" }] },
    ] } };
  const plain = projectDatedRoute(detail)!;
  assert.deepEqual(plain[0]!.spots!.map((spot: any) => spot.name), ["西宁", "塔尔寺、八瓣莲花山", "日月山"]);
  const withAi = projectDatedRoute(structured as unknown as ProductDetail)!;
  assert.deepEqual(withAi[0]!.spots!.map((spot: any) => spot.name), ["西宁", "塔尔寺", "八瓣莲花山", "日月山"]);
  assert.equal(withAi[0]!.hotelCity, "湟中");
});
