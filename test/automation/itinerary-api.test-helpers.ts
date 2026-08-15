/**
 * itinerary-api.test-helpers.ts：行程 soa2 接口测试的共享基础设施。
 *
 *  - fetch stub：拦截全局 fetch，把 soa2 endpoint 转到 routeHandlers；
 *  - fakePage：让 vbkSessionRequest 的 evaluate 闭包在 Node 内同步执行；
 *  - baseProduct / baseProductNoHotel：测试用的归一化 product；
 *  - makeReadbackDays：根据 overrides 构造完整回读 payload；
 *  - makeHandlers：根据 overrides 构造各 endpoint 的回包；
 *  - installHandlersForFieldMismatch：错配测试共用入口（自动注入 baseProduct
 *    风格的 title）。
 *
 * 由 orchestration / readback 两份 .test.ts 共同 import，避免在测试文件
 * 内部维护重复 fixture / mock。
 */

import type { StationCandidate } from "../../src/main/automation/ctrip/itinerary-api/station-search.ts";

/** ───────── fetch stub + fake page ───────── */

export type StubHandler = (body: any) => any;

export const routeHandlers: Record<string, StubHandler> = {};
export const callLog: Array<{ endpoint: string; body: any }> = [];

let fetchStubInstalled = false;
let prevDocument: any = undefined;
let prevFetch: typeof fetch | undefined = undefined;

export function installFetchStub(): void {
  if (fetchStubInstalled) return;
  prevDocument = (globalThis as any).document;
  prevFetch = globalThis.fetch;
  (globalThis as any).document = { cookie: "GUID=GUID-VALUE" };
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input);
    const u = new URL(url);
    const endpoint = u.pathname;
    let body: any = {};
    if (init?.body) {
      try {
        body = JSON.parse(String(init.body));
      } catch {
        body = {};
      }
    }
    callLog.push({ endpoint, body });
    const handler = routeHandlers[endpoint];
    const payload = handler
      ? handler(body)
      : {
          ResponseStatus: { Ack: "Failure", Errors: [{ Message: `未注册的 endpoint: ${endpoint}` }] },
        };
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  fetchStubInstalled = true;
}

export function uninstallFetchStub(): void {
  if (!fetchStubInstalled) return;
  if (prevFetch === undefined) delete (globalThis as any).fetch;
  else globalThis.fetch = prevFetch;
  if (prevDocument === undefined) delete (globalThis as any).document;
  else (globalThis as any).document = prevDocument;
  fetchStubInstalled = false;
}

export function makeFakePage() {
  return {
    async evaluate<T, A = unknown>(fn: (arg: A) => T | Promise<T>, arg: A): Promise<T> {
      return await fn(arg);
    },
  };
}

export function clearRouteHandlers(): void {
  for (const key of Object.keys(routeHandlers)) delete routeHandlers[key];
}

export function resetCallLog(): void {
  callLog.length = 0;
}

/** ───────── fixture ───────── */

export function makeCandidate(type: "air" | "train", code: string, name: string): StationCandidate {
  return { type, id: code, code, name, raw: {} };
}

export const baseProduct = {
  itinerary: [
    {
      day: 1,
      title: "第1天：抵达丽江",
      spots: [{ name: "古城", poiName: "Old Town of Lijiang", poiId: 75924 }],
      description: "自由活动",
      hotel: "和玺酒店",
      meals: "自理",
      mealDescriptions: ["酒店早餐", "纳西风味", "三文鱼宴"],
    },
    {
      day: 2,
      title: "第2天：玉龙雪山",
      spots: [{ name: "雪山", poiName: "Jade Dragon Snow Mountain", poiId: 10543884 }],
      description: "自由活动",
      hotel: "和玺酒店",
      meals: "自理",
      mealDescriptions: ["酒店早餐", "景区简餐", "纳西风味"],
    },
  ],
  operations: {
    hotelTier: "当地4钻酒店/-4",
    pickupCity: "丽江",
    transport: "charter",
    reusePickupForDropoff: true,
    mealsIncluded: false,
  } as any,
  productId: "77035928",
};

export const baseProductNoHotel = {
  itinerary: [
    { day: 1, title: "第1天", spots: [{ name: "古城", poiName: "Old Town of Lijiang", poiId: 75924 }], description: "自由活动", hotel: "", meals: "自理" },
    { day: 2, title: "第2天", spots: [{ name: "雪山", poiName: "Jade Dragon Snow Mountain", poiId: 10543884 }], description: "自由活动", hotel: "", meals: "自理" },
  ],
  operations: {
    hotelTier: "当地4钻酒店/-4",
    pickupCity: "丽江",
    transport: "charter",
    reusePickupForDropoff: true,
    mealsIncluded: false,
  } as any,
  productId: "77035928",
};

/** ───────── readback payload 构造 ───────── */

export interface ReadbackDayOverrides {
  readbackDays?: number;
  title?: (i: number) => string;
  poi?: (i: number) => Array<{ poiId: number; poiName: string }>;
  hotelName?: (i: number) => string;
  mealIncluded?: boolean;
  otherDescription?: (i: number) => string;
  serviceStart?: string;
  serviceEnd?: string;
  pickupAirport?: string;
  pickupTrain?: string;
  pickupName?: string;
  dropoffAirport?: string;
  dropoffTrain?: string;
  dropoffName?: string;
}

export function makeReadbackDays(opts: ReadbackDayOverrides = {}) {
  const total = opts.readbackDays ?? 2;
  const days: Array<Record<string, unknown>> = [];
  for (let i = 0; i < total; i += 1) {
    const pois = opts.poi ? opts.poi(i) : [
      { poiId: i === 0 ? 75924 : 10543884, poiName: i === 0 ? "Old Town of Lijiang" : "Jade Dragon Snow Mountain" },
    ];
    const hotelName = opts.hotelName ? opts.hotelName(i) : "和玺酒店";
    const isFirst = i === 0;
    const isLast = i === total - 1;
    const mealIncluded = opts.mealIncluded ?? false;
    const includeAdultKey = mealIncluded ? "I" : "E";
    days.push({
      dailyDescription: opts.title ? opts.title(i) : (i === 0 ? "第1天" : "第2天"),
      tourDailyInfos: [
        // 首日接机（仅首日）
        ...(isFirst ? [{
          activeType: { key: 25, name: "集合" },
          tourDailyPackageGatherList: [{
            airports: [{ code: opts.pickupAirport ?? "LJG", name: opts.pickupName ?? "三义机场" }],
            trainStations: [{ locationCode: opts.pickupTrain ?? "CN001LHM", stationName: "丽江" }],
            serviceAllDay: true,
            useCar: { key: "1", name: "专车" },
          }],
        }] : []),
        // 景点
        {
          activeType: { key: 3, name: "景点" },
          tourDailyPois: pois.map((p, idx) => ({ sort: idx + 1, poi: { poiId: p.poiId, poiName: p.poiName } })),
        },
        // 三餐
        { activeType: { key: 0, name: "餐饮" }, tourDailyDinner: { dinnerType: { key: "B" }, includeAdult: { key: includeAdultKey } } },
        { activeType: { key: 0, name: "餐饮" }, tourDailyDinner: { dinnerType: { key: "L" }, includeAdult: { key: includeAdultKey } } },
        { activeType: { key: 0, name: "餐饮" }, tourDailyDinner: { dinnerType: { key: "S" }, includeAdult: { key: includeAdultKey } } },
        // 酒店（仅当 hotelName 非空时）
        ...(hotelName ? [{
          activeType: { key: 1, name: "酒店" },
          tourDailyHotels: [{ hotel: { hotelName, grade: { name: "当地4钻酒店/-4" } } }],
        }] : []),
        // 其他 + 服务时间
        {
          activeType: { key: 7, name: "自由活动" },
          description: opts.otherDescription ? opts.otherDescription(i) : "自由活动",
          startOnBoardTime: opts.serviceStart ?? "08:00",
          stopOnBoardTime: opts.serviceEnd ?? "20:00",
        },
        // 末日送机
        ...(isLast ? [{
          activeType: { key: 26, name: "解散" },
          tourDailyPackageDismissList: [{
            airports: [{ code: opts.dropoffAirport ?? "LJG", name: opts.dropoffName ?? "三义机场" }],
            trainStations: [{ locationCode: opts.dropoffTrain ?? "CN001LHM", stationName: "丽江" }],
            serviceAllDay: true,
            useCar: { key: "1", name: "专车" },
          }],
        }] : []),
      ],
    });
  }
  return days;
}

/** ───────── endpoint handlers ───────── */

export interface HandlersOverrides {
  tourInfoId?: string | number;
  newTourInfoId?: string | number;
  readbackDays?: number;
  readbackOverrides?: ReadbackDayOverrides;
  /** getProductTourInfoList 是否返回空 tourInfos（用于空产品 / 新建行程测试）。 */
  emptyProduct?: boolean;
  /** getDailyTemplateDetail 响应里 template 字段的覆写（默认含 templateId/days/空 desc）。 */
  templateOverride?: Record<string, unknown>;
  /** 第一次 getTourDailyDetail 调用（非 readback）使用的响应。空产品场景下不走这一步。 */
  detailOverride?: (defaultBody: { days: Array<Record<string, unknown>>; newTourInfoId: string | number }) => Record<string, unknown>;
  /** getDailyTemplateDetail 响应覆写（覆盖整个 payload），用于模拟空 template。 */
  templatePayloadOverride?: Record<string, unknown>;
}

export function makeHandlers(opts: HandlersOverrides = {}) {
  const tourInfoId = opts.tourInfoId ?? "409136029189275700";
  const newTourInfoId = opts.newTourInfoId ?? "999999999999999999";
  const readbackDays = opts.readbackDays ?? 2;
  let detailCallCount = 0;
  return {
    "/restapi/soa2/20049/suggestAirport": () => ({
      ResponseStatus: { Ack: "Success", Errors: [] },
      airports: [{ code: "LJG", name: "三义机场" }],
    }),
    "/restapi/soa2/20049/suggestTrainStation": () => ({
      ResponseStatus: { Ack: "Success", Errors: [] },
      trainStations: [{ stationNo: 37, stationName: "丽江", locationCode: "CN001LHM", geoId: "37" }],
    }),
    "/restapi/soa2/20049/suggestPoi": (body: { keyword?: string }) => ({
      ResponseStatus: { Ack: "Success", Errors: [] },
      poiList: [{
        poiId: body.keyword === "Jade Dragon Snow Mountain" ? 10543884 : 75924,
        poiName: body.keyword ?? "",
        poiType: { key: 3, name: "景点" },
        ticketType: { key: 1, name: "收费" },
      }],
    }),
    "/restapi/soa2/15638/getProductTourInfoList": () => ({
      ResponseStatus: { Ack: "Success", Errors: [] },
      tourInfos: opts.emptyProduct
        ? []
        : [{
            tourInfoId: Number(tourInfoId) || tourInfoId,
            productId: 77035928,
            main: true,
            sort: 0,
          }],
    }),
    "/restapi/soa2/20049/getDailyTemplateDetail": () => {
      if (opts.templatePayloadOverride) {
        return {
          ResponseStatus: { Ack: "Success", Errors: [] },
          ...opts.templatePayloadOverride,
        };
      }
      return {
        ResponseStatus: { Ack: "Success", Errors: [] },
        template: opts.templateOverride ?? {
          templateId: 3,
          days: 2,
          tourDailyDescriptions: [],
        },
        templateId: 3,
      };
    },
    "/restapi/soa2/20049/getTourDailyDetail.json": () => {
      const days = makeReadbackDays({ readbackDays, ...(opts.readbackOverrides ?? {}) });
      detailCallCount += 1;
      if (opts.detailOverride && detailCallCount === 1) {
        return {
          ResponseStatus: { Ack: "Success", Errors: [] },
          ...opts.detailOverride({ days, newTourInfoId }),
        };
      }
      return {
        ResponseStatus: { Ack: "Success", Errors: [] },
        tourInfo: { tourInfoId: newTourInfoId, tourDailyDescriptions: days },
      };
    },
    "/restapi/soa2/15638/checkTourDaily": (b: any) => {
      // 从请求 body.tourDaily 中提取 tourDailyDescriptions 数组。
      // body.tourDaily 现在可能是完整 newTourInfo（含 tourInfoId/template/templateId/days/tourDailyDescriptions/...）
      // 也可能是裸 { tourDailyDescriptions }；两种都要兼容。
      let descriptions: unknown[] = [];
      if (b?.tourDaily) {
        try {
          const parsed = JSON.parse(typeof b.tourDaily === "string" ? b.tourDaily : JSON.stringify(b.tourDaily));
          if (Array.isArray(parsed?.tourDailyDescriptions)) {
            descriptions = parsed.tourDailyDescriptions as unknown[];
          }
        } catch {
          // ignore parse errors, fall back to empty array
        }
      }
      return {
        ResponseStatus: { Ack: "Success", Errors: [] },
        tourDaily: JSON.stringify({
          tourInfoId: newTourInfoId,
          tourDailyDescriptions: descriptions,
        }),
      };
    },
    "/restapi/soa2/20049/calculateTourInfoScore": () => ({
      ResponseStatus: { Ack: "Success", Errors: [] },
      tourInfo: { aggregateScore: 80, tourInfoScores: [] },
    }),
    "/restapi/soa2/20049/saveTourDailyDetail.json": () => ({
      ResponseStatus: { Ack: "Success", Errors: [] },
      tourInfo: { tourInfoId: newTourInfoId },
    }),
    "/restapi/soa2/15638/saveProductTourInfo": () => ({
      ResponseStatus: { Ack: "Success", Errors: [] },
    }),
  };
}

/** ───────── 错配测试共用入口 ───────── */

export function baseProductTitle(i: number): string {
  return i === 0 ? "第1天：抵达丽江" : "第2天：玉龙雪山";
}

/**
 * 为字段级错配测试准备的 handler 安装助手：自动注入 baseProduct 风格的 title，
 * 业务字段（酒店名 / 服务时间等）默认对齐 baseProduct。仅当测试故意覆盖某字段
 * 才会触发错配。
 */
export function installHandlersForFieldMismatch(overrides: ReadbackDayOverrides): void {
  Object.assign(
    routeHandlers,
    makeHandlers({ readbackOverrides: { title: baseProductTitle, ...overrides } }),
  );
}
