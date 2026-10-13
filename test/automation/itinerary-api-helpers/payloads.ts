import { HOTEL_SELECTION_NOTE } from "../../../src/shared/itinerary-service-copy.js";
import type { VbkDailyUseCar } from "../../../src/shared/product-form.js";
import { routeHandlers, makeCandidate, type StubHandler } from "./runtime.js";
export interface ReadbackDayOverrides {
  readbackDays?: number;
  title?: (i: number) => string;
  poi?: (i: number) => Array<{ poiId: number; poiName: string }>;
  omitAttraction?: (i: number) => boolean;
  hotelName?: (i: number) => string;
  mealIncluded?: boolean;
  useCar?: VbkDailyUseCar;
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
    const hotelName = opts.hotelName ? opts.hotelName(i) : "使用携程平台酒店，自动匹配三钻、四钻、五钻酒店";
    const isFirst = i === 0;
    const isLast = i === total - 1;
    const mealIncluded = opts.mealIncluded ?? false;
    const breakfastIncludeAdultKey = mealIncluded ? "I" : "E";
    days.push({
      dailyDescription: opts.title ? opts.title(i) : (i === 0 ? "第1天" : "第2天"),
      useCar: opts.useCar ?? { key: "B", name: "包车" },
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
        // 首日不排早餐；午、晚餐固定自理；尾日不排晚餐。
        ...(!isFirst ? [{
          activeType: { key: 0, name: "餐饮" },
          description: "是否含餐，以酒店房型为准。",
          tourDailyDinner: { dinnerType: { key: "B" }, includeAdult: { key: breakfastIncludeAdultKey } },
        }] : []),
        { activeType: { key: 8, name: "交通" }, takeoffTime: { key: "D", name: "全天" }, description: `${opts.title ? opts.title(i) : (i === 0 ? "第1天" : "第2天")}，全天用车` },
        // 景点
        ...(!opts.omitAttraction?.(i) ? [{
          activeType: { key: 3, name: "景点" },
          tourDailyPois: pois.map((p, idx) => ({
            sort: idx + 1,
            poi: { poiId: p.poiId, poiName: p.poiName },
            suffixName: { key: 13, name: "含成人儿童首道门票" },
          })),
        }] : []),
        { activeType: { key: 0, name: "餐饮" }, tourDailyDinner: { dinnerType: { key: "L" }, includeAdult: { key: "E" } } },
        ...(!isLast ? [{ activeType: { key: 0, name: "餐饮" }, tourDailyDinner: { dinnerType: { key: "S" }, includeAdult: { key: "E" } } }] : []),
        // 酒店（仅当 hotelName 非空时）
        ...(hotelName ? [{
          activeType: { key: 1, name: "酒店" },
          useSegmentConfig: true,
          description: `${hotelName}\n${HOTEL_SELECTION_NOTE}`,
          tourDailyHotels: [{ hotel: { hotelName, grade: { key: -4, name: "当地4钻酒店" } } }],
        }] : []),
        // 其他 + 服务时间
        {
          activeType: { key: 9, name: "其他" },
          description: opts.otherDescription ? opts.otherDescription(i) : "自由活动",
          takeoffTime: { key: null, name: "下午" },
          takeTime: 120,
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
  const draftTourInfoId = "417899634191761447";
  const previewTourInfoId = "417815590194610231";
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
            tourInfoId,
            draftTourInfoId,
            auditTourInfoId: tourInfoId,
            previewTourInfoId,
            draftTourInfoStatus: 1,
            auditTourInfoStatus: 2,
            auditStatus: { key: "A", value: "审核通过" },
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
          tourInfoId: draftTourInfoId,
          draftTourInfoId,
          auditTourInfoId: tourInfoId,
          previewTourInfoId,
          draftTourInfoStatus: 1,
          auditTourInfoStatus: 2,
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
      tourInfoId: draftTourInfoId,
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
