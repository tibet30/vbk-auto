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
      { operations: { hotelTier: "当地4钻酒店/-4", hotelResource: { source: "ctrip" } }, itinerary: [{ day: 1, hotel: "日喀则酒店1", hotelCandidates: candidates(100, 100, "日喀则") }] },
      "78159725",
    );
    assert.equal(result.verified, true);
    assert.equal(saveAttempts, 2);
    assert.deepEqual(segment.hotel.segmentRooms.map((room: any) => room.masterHotelID), [100, 101, 102, 103, 104]);
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
    assert.deepEqual(segments[1].hotel.segmentRooms.map((room: any) => room.masterHotelID), [100, 101, 102, 103, 104]);
    assert.deepEqual(segments[2].hotel.segmentRooms.map((room: any) => room.masterHotelID), [200, 201, 202, 203, 204]);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldDocument === undefined) delete (globalThis as any).document;
    else (globalThis as any).document = oldDocument;
  }
});

test("非私家团在酒店名单写入草稿后提交，并以正式段回读确认", async () => {
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
  let submitted = false;
  const calls: string[] = [];
  (globalThis as any).document = { cookie: "GUID=fixture" };
  globalThis.fetch = (async (input: any, init?: any) => {
    const endpoint = new URL(String(input)).pathname;
    calls.push(endpoint);
    if (endpoint.endsWith("saveSegment")) {
      const saved = JSON.parse(String(init?.body ?? "{}")).segment;
      segments = segments.map((segment) => String(segment.segmentId) === String(saved.segmentId) ? saved : segment);
    }
    if (endpoint.endsWith("submitSegments")) submitted = true;
    const payload = endpoint.endsWith("getSegments")
      ? {
        ResponseStatus: { Ack: "Success" },
        draftProductSegments: { segments },
        ...(submitted ? { productSegments: { segments: structuredClone(segments) } } : {}),
      }
      : { ResponseStatus: { Ack: "Success" } };
    return new Response(JSON.stringify(payload), { status: 200 });
  }) as typeof fetch;
  try {
    const result = await ensureHotelResourceApi(
      { evaluate: async (fn: any, arg: any) => fn(arg) },
      {
        sales: { productForm: "groupTour" },
        operations: { hotelTier: "当地5钻酒店/-38" },
        itinerary: [
          { day: 1, hotel: "日喀则酒店", hotelCandidates: candidates(100, 100, "日喀则") },
        ],
      },
      "78120988",
    );
    assert.equal(result.verified, true);
    assert.equal(submitted, true);
    assert.ok(calls.some((endpoint) => endpoint.endsWith("submitSegments")));
  } finally {
    globalThis.fetch = oldFetch;
    if (oldDocument === undefined) delete (globalThis as any).document;
    else (globalThis as any).document = oldDocument;
  }
});

test("私家团酒店阶段不提交资源草稿，留给后续用车阶段", async () => {
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
  const calls: string[] = [];
  (globalThis as any).document = { cookie: "GUID=fixture" };
  globalThis.fetch = (async (input: any, init?: any) => {
    const endpoint = new URL(String(input)).pathname;
    calls.push(endpoint);
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
    await ensureHotelResourceApi(
      { evaluate: async (fn: any, arg: any) => fn(arg) },
      {
        sales: { productForm: "privateTour" },
        operations: { hotelTier: "当地5钻酒店/-38" },
        itinerary: [
          { day: 1, hotel: "日喀则酒店", hotelCandidates: candidates(100, 100, "日喀则") },
        ],
      },
      "78120988",
    );
    assert.ok(!calls.some((endpoint) => endpoint.endsWith("submitSegments")));
  } finally {
    globalThis.fetch = oldFetch;
    if (oldDocument === undefined) delete (globalThis as any).document;
    else (globalThis as any).document = oldDocument;
  }
});
