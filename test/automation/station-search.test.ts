// 锁死 station-search 的契约：
//   - normalizeAirportCandidates / normalizeTrainCandidates 仅当 code 与 name
//     都非空时保留，禁止让 name 充当 id；
//   - 空数组输入 / 非数组 / null / undefined 都返回 []，不抛错；
//   - searchAirports / searchTrainStations 的请求字段（contentType / head /
//     requestHeader.locale + keyword）和响应结构（Ack + airports / trainStations）
//     通过 Node 内 fetch stub + 内联 soa2 响应 fixture 验证；
//   - fixture 来自先前线上抓取的脱敏样本（丽江 / 上海唯一匹配 / 上海多候选 /
//     无业务匹配 → []），存放在本测试文件内，不依赖 /tmp 任何外部文件，干净
//     环境也能确定性通过。
import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeAirportCandidates,
  normalizeTrainCandidates,
  searchAirports,
  searchTrainStations,
  type StationCandidate,
} from "../../src/main/automation/ctrip/itinerary-api/station-search.ts";

// ───────── normalize 单测 ─────────

test("normalizeAirportCandidates：code 与 name 都非空才保留；缺一即过滤；id 等于 code", () => {
  const items = [
    { airportCode: "LJG", airportName: "三义机场" },
    { airportCode: "PVG", airportName: "浦东国际机场" },
    { airportCode: "", airportName: "" }, // 双空：剔除
    { airportCode: "SHA" }, // name 缺失：剔除（不能让 name 充当 id）
    { airportName: "无名机场" }, // code 缺失：剔除（不能让 name 充当 id）
    { airportCode: "  ", airportName: "深圳宝安国际机场" }, // code 全空白：剔除
    { airportCode: "SZX", airportName: "" }, // name 空：剔除
    null,
    "string",
  ];
  const out = normalizeAirportCandidates(items);
  assert.equal(out.length, 2);
  for (const item of out) {
    assert.equal(item.type, "air");
    assert.ok(item.code);
    assert.ok(item.name);
    assert.equal(item.id, item.code, "id 必须等于 code，不允许 name 充当 id");
  }
  assert.deepEqual(out.map((c) => c.code), ["LJG", "PVG"]);
  assert.deepEqual(out.map((c) => c.name), ["三义机场", "浦东国际机场"]);
});

test("normalizeTrainCandidates：code 与 name 都非空才保留；id 等于 code", () => {
  const items = [
    { stationNo: 37, stationName: "丽江", locationCode: "CN001LHM", geoId: "37" },
    { stationNo: 12, stationName: "南京", locationCode: "CN001NJH", geoId: "12" },
    { stationNo: 0, stationName: "", locationCode: "" }, // 双空：剔除
    { locationCode: "CN001XXX" }, // name 缺失：剔除
    { stationName: "无名站" }, // code 缺失：剔除
    null,
  ];
  const out = normalizeTrainCandidates(items);
  assert.equal(out.length, 2);
  for (const item of out) {
    assert.equal(item.type, "train");
    assert.ok(item.code);
    assert.ok(item.name);
    assert.equal(item.id, item.code);
  }
  assert.deepEqual(
    out.map((c) => ({ code: c.code, name: c.name })),
    [
      { code: "CN001LHM", name: "丽江" },
      { code: "CN001NJH", name: "南京" },
    ],
  );
});

test("normalize* 收到非数组 / null / undefined 都返回 []，不抛错", () => {
  for (const bad of [null, undefined, 0, "", "x", {}, true]) {
    assert.deepEqual(normalizeAirportCandidates(bad as unknown), []);
    assert.deepEqual(normalizeTrainCandidates(bad as unknown), []);
  }
});

// ───────── 内联 soa2 响应 fixture（脱敏后的最小可用样本）─────────

interface AirportFixture {
  keyword: string;
  airports: Array<{ code: string; name: string }>;
}

interface TrainFixture {
  keyword: string;
  trainStations: Array<{ stationNo: number; stationName: string; locationCode: string; geoId: string }>;
}

const AIRPORT_FIXTURES: AirportFixture[] = [
  // 单候选（业务高频场景）：丽江 → 三义机场。
  { keyword: "丽江", airports: [{ code: "LJG", name: "三义机场" }] },
  // 单候选：南京 → 禄口国际机场。
  { keyword: "南京", airports: [{ code: "NKG", name: "禄口国际机场" }] },
  // 多候选（业务也常见）：上海 → 浦东/虹桥/上海（其它老机场，名称与 code 都齐全）。
  { keyword: "上海", airports: [
    { code: "PVG", name: "浦东国际机场" },
    { code: "SHA", name: "虹桥国际机场" },
    { code: "SHS", name: "上海第三机场" },
  ] },
  // 无业务匹配：空数组（不视为失败）。
  { keyword: "XXNOTFOUNDXX", airports: [] },
];

const TRAIN_FIXTURES: TrainFixture[] = [
  { keyword: "丽江", trainStations: [{ stationNo: 37, stationName: "丽江", locationCode: "CN001LHM", geoId: "37" }] },
  { keyword: "上海", trainStations: [
    { stationNo: 1, stationName: "上海", locationCode: "CN001SHH", geoId: "1" },
    { stationNo: 2, stationName: "上海虹桥", locationCode: "CN001AOH", geoId: "2" },
    { stationNo: 3, stationName: "上海南", locationCode: "CN001SOU", geoId: "3" },
  ] },
  { keyword: "XXNOTFOUNDXX", trainStations: [] },
];

function findAirportFixture(keyword: string): AirportFixture | undefined {
  return AIRPORT_FIXTURES.find((f) => f.keyword === keyword);
}
function findTrainFixture(keyword: string): TrainFixture | undefined {
  return TRAIN_FIXTURES.find((f) => f.keyword === keyword);
}

// ───────── fetch stub + fakePage ─────────

let capturedAirportRequest: { url: string; body: Record<string, unknown> } | null = null;
let capturedTrainRequest: { url: string; body: Record<string, unknown> } | null = null;
let prevDocument: unknown = undefined;
let prevFetch: typeof fetch | undefined = undefined;
let stubInstalled = false;

function installFetchStub() {
  if (stubInstalled) return;
  prevDocument = (globalThis as { document?: unknown }).document;
  prevFetch = globalThis.fetch;
  (globalThis as { document?: unknown }).document = { cookie: "GUID=GUID-VALUE" };
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    let body: Record<string, unknown> = {};
    if (init?.body) {
      try {
        body = JSON.parse(String(init.body)) as Record<string, unknown>;
      } catch {
        body = {};
      }
    }
    if (url.includes("/20049/suggestAirport")) {
      capturedAirportRequest = { url, body };
      const keyword = typeof body.keyword === "string" ? body.keyword : "";
      const fixture = findAirportFixture(keyword);
      return new Response(
        JSON.stringify({
          ResponseStatus: { Ack: "Success", Errors: [] },
          airports: fixture ? fixture.airports : [],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes("/20049/suggestTrainStation")) {
      capturedTrainRequest = { url, body };
      const keyword = typeof body.keyword === "string" ? body.keyword : "";
      const fixture = findTrainFixture(keyword);
      return new Response(
        JSON.stringify({
          ResponseStatus: { Ack: "Success", Errors: [] },
          trainStations: fixture ? fixture.trainStations : [],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({ ResponseStatus: { Ack: "Failure", Errors: [{ Message: `unexpected ${url}` }] } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  stubInstalled = true;
}

function uninstallFetchStub() {
  if (!stubInstalled) return;
  if (prevFetch === undefined) delete (globalThis as { fetch?: typeof fetch }).fetch;
  else (globalThis as { fetch?: typeof fetch }).fetch = prevFetch;
  if (prevDocument === undefined) delete (globalThis as { document?: unknown }).document;
  else (globalThis as { document?: unknown }).document = prevDocument;
  stubInstalled = false;
}

function fakePage() {
  return {
    async evaluate<T, A = unknown>(fn: (arg: A) => T | Promise<T>, arg: A): Promise<T> {
      return await fn(arg);
    },
  };
}

test.before(() => {
  installFetchStub();
});

test.after(() => {
  uninstallFetchStub();
});

test.beforeEach(() => {
  capturedAirportRequest = null;
  capturedTrainRequest = null;
});

// ───────── 契约校验（fetch stub 驱动 searchAirports / searchTrainStations）─────────

test("searchAirports 请求体含 requestHeader.locale=zh-CN + contentType=json + keyword", async () => {
  await searchAirports(fakePage() as never, "丽江");
  assert.ok(capturedAirportRequest, "必须发起 suggestAirport 请求");
  const req = capturedAirportRequest as { url: string; body: Record<string, unknown> };
  assert.match(req.url, /\/restapi\/soa2\/20049\/suggestAirport/);
  assert.equal(req.body.contentType, "json");
  const requestHeader = req.body.requestHeader as Record<string, unknown>;
  assert.equal(requestHeader.locale, "zh-CN");
  assert.equal(req.body.keyword, "丽江");
});

test("searchAirports：丽江 单候选 → LJG / 三义机场", async () => {
  const out = await searchAirports(fakePage() as never, "丽江");
  assert.equal(out.length, 1);
  assert.equal(out[0].type, "air");
  assert.equal(out[0].code, "LJG");
  assert.equal(out[0].name, "三义机场");
});

test("searchAirports：上海 多候选 → ≥3 个（PVG / SHA / SHS）", async () => {
  const out = await searchAirports(fakePage() as never, "上海");
  assert.ok(out.length >= 3);
  const codes = out.map((c) => c.code);
  assert.ok(codes.includes("PVG"));
  assert.ok(codes.includes("SHA"));
});

test("searchAirports：南京 单候选 → NKG / 禄口国际机场", async () => {
  const out = await searchAirports(fakePage() as never, "南京");
  assert.equal(out.length, 1);
  assert.equal(out[0].code, "NKG");
  assert.equal(out[0].name, "禄口国际机场");
});

test("searchAirports：关键字无业务匹配 → 返回 []（不抛错）", async () => {
  const out = await searchAirports(fakePage() as never, "XXNOTFOUNDXX");
  assert.deepEqual(out, []);
});

test("searchTrainStations 请求体含 requestHeader.locale=zh-CN + contentType=json + keyword", async () => {
  await searchTrainStations(fakePage() as never, "丽江");
  assert.ok(capturedTrainRequest, "必须发起 suggestTrainStation 请求");
  const req = capturedTrainRequest as { url: string; body: Record<string, unknown> };
  assert.match(req.url, /\/restapi\/soa2\/20049\/suggestTrainStation/);
  assert.equal(req.body.contentType, "json");
  const requestHeader = req.body.requestHeader as Record<string, unknown>;
  assert.equal(requestHeader.locale, "zh-CN");
  assert.equal(req.body.keyword, "丽江");
});

test("searchTrainStations：丽江 单候选 → CN001LHM / 丽江", async () => {
  const out = await searchTrainStations(fakePage() as never, "丽江");
  assert.equal(out.length, 1);
  assert.equal(out[0].type, "train");
  assert.equal(out[0].code, "CN001LHM");
  assert.equal(out[0].name, "丽江");
});

test("searchTrainStations：上海 多候选 → ≥3 个（含 CN001SHH / CN001AOH）", async () => {
  const out = await searchTrainStations(fakePage() as never, "上海");
  assert.ok(out.length >= 3);
  const codes = out.map((c) => c.code);
  assert.ok(codes.includes("CN001SHH"));
  assert.ok(codes.includes("CN001AOH"));
});

test("searchTrainStations：关键字无业务匹配 → 返回 []（不抛错）", async () => {
  const out = await searchTrainStations(fakePage() as never, "XXNOTFOUNDXX");
  assert.deepEqual(out, []);
});

test("searchAirports / searchTrainStations 空 keyword 直接返回 []，不发请求", async () => {
  const pageStub = { evaluate: async () => { throw new Error("must not evaluate"); } };
  await Promise.all([
    searchAirports(pageStub as never, "").then((r: StationCandidate[]) => assert.deepEqual(r, [])),
    searchTrainStations(pageStub as never, " ").then((r: StationCandidate[]) => assert.deepEqual(r, [])),
  ]);
});
