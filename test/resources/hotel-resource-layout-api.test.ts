import assert from "node:assert/strict";
import test from "node:test";
import { ensureHotelResourceApi } from "../../src/main/automation/ctrip/hotel-resource-api.js";

const city = (cityId: number, cityName: string) => ({
  cityId,
  cityName,
  countryId: 1,
  countryName: "中国",
  provinceId: 22,
  provinceName: "四川",
});

const candidates = (start: number, cityId: number, cityName: string) => Array.from({ length: 5 }, (_, index) => ({
  hotelId: start + index,
  hotelName: `${cityName}酒店${index + 1}`,
  diamond: 5,
  distanceKm: index + 1,
  cityName,
  anchorCityId: cityId,
}));

test('酒店字段为“无”时不创建平台酒店资源', async () => {
  const result = await ensureHotelResourceApi(
    { evaluate: async (fn: any, arg: any) => fn(arg) },
    { itinerary: [{ day: 1, hotel: "无" }, { day: 2, hotel: "" }] },
    "77977327",
  );
  assert.deepEqual(result, { skipped: "行程不含住宿", verified: true });
});

test("送站日写成“当日返程，不安排住宿”时只校验真实住宿日", async () => {
  const oldFetch = globalThis.fetch;
  const oldDocument = (globalThis as any).document;
  const rikaze = city(100, "日喀则");
  const lodging = {
    segmentId: "lodging-1",
    productId: 78120988,
    segmentBase: {
      segmentNumber: 2,
      departureCity: rikaze,
      destinationCity: rikaze,
      stayNights: 1,
      minStayNights: 1,
      maxStayNights: 1,
      deleteable: true,
    },
    hotel: { segmentRooms: [] },
  };
  let segments = [
    { ...lodging, segmentId: "full-trip", segmentBase: { ...lodging.segmentBase, segmentNumber: 1, stayNights: 0, minStayNights: 0, maxStayNights: 0, deleteable: false } },
    lodging,
    { ...lodging, segmentId: "terminal", segmentBase: { ...lodging.segmentBase, segmentNumber: 3, stayNights: 0, minStayNights: 0, maxStayNights: 0 } },
  ];
  (globalThis as any).document = { cookie: "GUID=fixture" };
  globalThis.fetch = (async (input: any, init?: any) => {
    const endpoint = new URL(String(input)).pathname;
    if (endpoint.endsWith("saveSegment")) {
      const saved = JSON.parse(String(init?.body ?? "{}")).segment;
      segments = segments.map((segment) => String(segment.segmentId) === String(saved.segmentId) ? saved : segment);
    }
    const payload = endpoint.endsWith("getSegments")
      ? { ResponseStatus: { Ack: "Success" }, draftProductSegments: { segments } }
      : { ResponseStatus: { Ack: "Success" } };
    return new Response(JSON.stringify(payload), { status: 200 });
  }) as typeof fetch;
  try {
    const result = await ensureHotelResourceApi(
      { evaluate: async (fn: any, arg: any) => fn(arg) },
      {
        sales: { productForm: "privateTour" },
        operations: { hotelTier: "当地5钻酒店/-38" },
        itinerary: [
          { day: 1, hotel: "日喀则酒店", hotelCandidates: candidates(100, 100, "日喀则") },
          { day: 2, hotel: "当日返程，不安排住宿" },
        ],
      },
      "78120988",
    );
    assert.equal(result.verified, true);
    assert.deepEqual(result.layout.expected, [{ cityName: "日喀则", nights: 1 }]);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldDocument === undefined) delete (globalThis as any).document;
    else (globalThis as any).document = oldDocument;
  }
});

test("指定酒店保存明确提示草稿不存在且回读为空时，重建草稿后只重试一次", async () => {
  const oldFetch = globalThis.fetch;
  const oldDocument = (globalThis as any).document;
  const rikaze = city(100, "日喀则");
  let createdDraft = false;
  let saveAttempts = 0;
  let segment: any = {
    segmentId: "lodging-1", productId: 78159725,
    segmentBase: { segmentNumber: 2, departureCity: rikaze, destinationCity: rikaze, stayNights: 1, minStayNights: 1, maxStayNights: 1, deleteable: true },
    hotel: { segmentRooms: [] },
  };
  const fullTrip = { ...segment, segmentId: "full-trip", segmentBase: { ...segment.segmentBase, segmentNumber: 1, stayNights: 0, minStayNights: 0, maxStayNights: 0, deleteable: false } };
  const terminal = { ...segment, segmentId: "terminal", segmentBase: { ...segment.segmentBase, segmentNumber: 3, stayNights: 0, minStayNights: 0, maxStayNights: 0 } };
  (globalThis as any).document = { cookie: "GUID=fixture" };
  globalThis.fetch = (async (input: any, init?: any) => {
    const endpoint = new URL(String(input)).pathname;
    if (endpoint.endsWith("createProductDraft")) createdDraft = true;
    if (endpoint.endsWith("saveSegment")) {
      saveAttempts += 1;
      if (!createdDraft) return new Response(JSON.stringify({ ResponseStatus: { Ack: "Failure", Errors: [{ ErrorCode: "20016116", Message: "产品还没有创建草稿。" }] } }), { status: 200 });
      segment = JSON.parse(String(init?.body ?? "{}")).segment;
    }
    const payload = endpoint.endsWith("getSegments")
      ? { ResponseStatus: { Ack: "Success" }, draftProductSegments: { segments: [fullTrip, segment, terminal] } }
      : { ResponseStatus: { Ack: "Success" } };
    return new Response(JSON.stringify(payload), { status: 200 });
  }) as typeof fetch;
  try {
    const result = await ensureHotelResourceApi(
      { evaluate: async (fn: any, arg: any) => fn(arg) },
      { sales: { productForm: "privateTour" }, operations: { hotelTier: "当地4钻酒店/-4", hotelResource: { source: "ctrip" } }, itinerary: [{ day: 1, hotel: "日喀则酒店1", hotelCandidates: candidates(100, 100, "日喀则") }] },
      "78159725",
    );
    assert.equal(result.verified, true);
    assert.equal(saveAttempts, 2);
    assert.deepEqual(segment.hotel.segmentRooms, []);
    assert.deepEqual(segment.hotel.systemHotel.hotelStar, [3, 4, 5]);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldDocument === undefined) delete (globalThis as any).document;
    else (globalThis as any).document = oldDocument;
  }
});

test("新建产品缺少住宿段时，自动按连续城市创建并让停留晚数等于住宿晚数", async () => {
  const oldFetch = globalThis.fetch;
  const oldDocument = (globalThis as any).document;
  const chengdu = city(28, "成都");
  const dujiangyan = city(94, "都江堰");
  const fullTrip = {
    segmentId: "full-trip",
    productId: 77977327,
    packages: [{ packageId: 1 }],
    hotelDays: [],
    segmentResourceGroups: [{ resourceGroupId: 9001 }],
    segmentBase: {
      segmentNumber: 1,
      departureCity: chengdu,
      destinationCity: chengdu,
      stayNights: 3,
      minStayNights: 3,
      maxStayNights: 3,
      deleteable: false,
    },
  };
  const terminal = {
    segmentId: "terminal",
    productId: 77977327,
    packages: [],
    hotelDays: [],
    segmentResourceGroups: [],
    segmentBase: {
      segmentNumber: 2,
      departureCity: chengdu,
      destinationCity: chengdu,
      stayNights: 0,
      minStayNights: 0,
      maxStayNights: 0,
      deleteable: true,
    },
  };
  let segments: any[] = [structuredClone(fullTrip), structuredClone(terminal)];
  let created = 0;
  const newSegmentIds: unknown[] = [];
  (globalThis as any).document = { cookie: "GUID=fixture" };
  globalThis.fetch = (async (input: any, init?: any) => {
    const endpoint = new URL(String(input)).pathname;
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (endpoint.endsWith("suggestDepartureCity")) {
      const match = body.keyword === "成都" ? chengdu : body.keyword === "都江堰" ? dujiangyan : null;
      return new Response(JSON.stringify({ ResponseStatus: { Ack: "Success" }, cities: match ? [match] : [] }), { status: 200 });
    }
    if (endpoint.endsWith("saveSegment")) {
      const draft = structuredClone(body.segment);
      if (Number(draft.segmentId) === 0) {
        newSegmentIds.push(draft.segmentId);
        created += 1;
        draft.segmentId = `lodging-${created}`;
        const insertAt = segments.findIndex((segment) => Number(segment.segmentBase.segmentNumber) >= Number(draft.segmentBase.segmentNumber));
        segments.splice(insertAt < 0 ? segments.length : insertAt, 0, draft);
        segments.forEach((segment, index) => { segment.segmentBase.segmentNumber = index + 1; });
      } else {
        segments = segments.map((segment) => String(segment.segmentId) === String(draft.segmentId) ? draft : segment);
      }
    }
    const payload = endpoint.endsWith("getSegments")
      ? { ResponseStatus: { Ack: "Success" }, draftProductSegments: { segments: structuredClone(segments) } }
      : { ResponseStatus: { Ack: "Success" } };
    return new Response(JSON.stringify(payload), { status: 200 });
  }) as typeof fetch;
  try {
    const result = await ensureHotelResourceApi(
      { evaluate: async (fn: any, arg: any) => fn(arg) },
      {
        sales: { productForm: "privateTour" },
        operations: { hotelTier: "当地5钻酒店/-38", hotelResource: { source: "ctrip" } },
        itinerary: [
          { day: 1, hotel: "成都酒店1", hotelCandidates: candidates(100, 28, "成都") },
          { day: 2, hotel: "成都酒店1", hotelCandidates: candidates(100, 28, "成都") },
          { day: 3, hotel: "都江堰酒店1", hotelCandidates: candidates(200, 94, "都江堰") },
        ],
      },
      "77977327",
    );

    assert.equal(result.layout.created, 2);
    assert.deepEqual(newSegmentIds, [0, 0]);
    assert.deepEqual(segments.map((segment) => ({
      city: segment.segmentBase.destinationCity.cityName,
      stay: segment.segmentBase.stayNights,
      min: segment.segmentBase.minStayNights,
      max: segment.segmentBase.maxStayNights,
    })), [
      { city: "成都", stay: 0, min: 0, max: 0 },
      { city: "成都", stay: 2, min: 2, max: 2 },
      { city: "都江堰", stay: 1, min: 1, max: 1 },
      { city: "成都", stay: 0, min: 0, max: 0 },
    ]);
    assert.deepEqual(segments[0].segmentResourceGroups, [{ resourceGroupId: 9001 }]);
    assert.deepEqual(segments[1].hotel.segmentRooms, []);
    assert.deepEqual(segments[1].hotel.systemHotel.hotelStar, [3, 4, 5]);
    assert.deepEqual(segments[2].hotel.segmentRooms, []);
    assert.deepEqual(segments[2].hotel.systemHotel.hotelStar, [3, 4, 5]);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldDocument === undefined) delete (globalThis as any).document;
    else (globalThis as any).document = oldDocument;
  }
});

test("缺少末尾空段时先补空段再新增住宿段", async () => {
  const chengdu = city(28, "成都");
  const fullTrip = { segmentId: "full-trip", productId: 80000001, segmentResourceGroups: [{ resourceGroupId: 9001 }],
    hotel: { segmentRooms: [] }, segmentBase: { segmentNumber: 1, departureCity: chengdu, destinationCity: chengdu,
      stayNights: 0, minStayNights: 0, maxStayNights: 0, deleteable: false } };
  let segments: any[] = [structuredClone(fullTrip)];
  const saves: any[] = [];
  const page = { nativeOnly: true, vbkSessionFetch: async (request: any) => {
    const action = new URL(request.endpoint).pathname.split("/").at(-1);
    assert.ok(["getSegments", "saveSegment", "suggestDepartureCity"].includes(action!), `unexpected external operation ${action}`);
    let extra = {};
    if (action === "suggestDepartureCity") extra = { cities: request.body.keyword === "成都" ? [chengdu] : [] };
    if (action === "saveSegment") {
      const draft = structuredClone(request.body.segment);
      saves.push(structuredClone(draft));
      if (Number(draft.segmentId) === 0) {
        draft.segmentId = `seg-${saves.length}`;
        if (Number(draft.segmentBase.stayNights) === 0) segments.push(draft); else segments.splice(-1, 0, draft);
        segments.forEach((segment, index) => { segment.segmentBase.segmentNumber = index + 1; });
      } else segments = segments.map(segment => segment.segmentId === draft.segmentId ? draft : segment);
    }
    if (action === "getSegments") extra = { draftProductSegments: { segments: structuredClone(segments) } };
    return { status: 200, payload: { ResponseStatus: { Ack: "Success" }, ...extra } };
  } };
  const result: any = await ensureHotelResourceApi(page, {
    sales: { productForm: "privateTour" }, basicInfo: { meetingCity: "成都", province: "四川", nights: 1 },
    itinerary: [{ day: 1, hotel: "平台酒店", hotelCity: "成都", spots: [] }, { day: 2, hotel: "无", spots: [] }],
  }, "80000001");
  assert.equal(result.verified, true);
  assert.equal(result.layout.created, 1);
  const terminalSave = saves[0];
  assert.equal(terminalSave.segmentId, 0);
  assert.equal(terminalSave.segmentBase.segmentNumber, 2);
  assert.deepEqual([terminalSave.segmentBase.stayNights, terminalSave.segmentBase.minStayNights, terminalSave.segmentBase.maxStayNights], [0, 0, 0]);
  assert.equal(terminalSave.segmentBase.deleteable, true);
  assert.deepEqual(terminalSave.segmentResourceGroups, []);
  assert.deepEqual(terminalSave.hotel, { segmentRooms: [] });
  assert.equal(saves[1].segmentId, 0);
  assert.equal(saves[1].segmentBase.stayNights, 1);
  assert.deepEqual(segments.map(segment => [segment.segmentBase.destinationCity.cityName, segment.segmentBase.stayNights]),
    [["成都", 0], ["成都", 1], ["成都", 0]]);
});

test("补建末尾空段后仍拿不到可用末尾段时停止并提示人工添加", async () => {
  const chengdu = city(28, "成都");
  const segments = [{ segmentId: "full-trip", productId: 80000002, hotel: { segmentRooms: [] }, segmentBase: { segmentNumber: 1,
    departureCity: chengdu, destinationCity: chengdu, stayNights: 0, minStayNights: 0, maxStayNights: 0, deleteable: false } }];
  let saves = 0;
  const page = { nativeOnly: true, vbkSessionFetch: async (request: any) => {
    const action = new URL(request.endpoint).pathname.split("/").at(-1);
    if (action === "saveSegment") saves++;
    const extra = action === "getSegments" ? { draftProductSegments: { segments: structuredClone(segments) } }
      : action === "suggestDepartureCity" ? { cities: [chengdu] } : {};
    return { status: 200, payload: { ResponseStatus: { Ack: "Success" }, ...extra } };
  } };
  await assert.rejects(ensureHotelResourceApi(page, {
    sales: { productForm: "privateTour" }, basicInfo: { meetingCity: "成都", province: "四川", nights: 1 },
    itinerary: [{ day: 1, hotel: "平台酒店", hotelCity: "成都", spots: [] }, { day: 2, hotel: "无", spots: [] }],
  }, "80000002"), /VBK 资源配置无法补出末尾空段，请在资源配置页手动添加一个空行程段后重试/);
  assert.equal(saves, 1);
});
