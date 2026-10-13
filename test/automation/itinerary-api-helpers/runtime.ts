import { HOTEL_SELECTION_NOTE } from "../../../src/shared/itinerary-service-copy.js";
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

import type { StationCandidate } from "../../../src/main/automation/ctrip/itinerary-api/station-search.ts";
import type { VbkDailyUseCar } from "../../../src/shared/product-form.js";

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
    trafficLine: {
      availability: {
        endpointPlan: {
          arrivalCity: "丽江", departureCity: "丽江", resolvedAt: "2026-09-30T00:00:00.000Z",
          flight: { arrival: { code: "LJG", name: "三义机场" }, departure: { code: "LJG", name: "三义机场" } },
          train: { arrival: { code: "CN001LHM", name: "丽江" }, departure: { code: "CN001LHM", name: "丽江" } },
        },
      },
    },
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
    trafficLine: {
      availability: {
        endpointPlan: {
          arrivalCity: "丽江", departureCity: "丽江", resolvedAt: "2026-09-30T00:00:00.000Z",
          flight: { arrival: { code: "LJG", name: "三义机场" }, departure: { code: "LJG", name: "三义机场" } },
          train: { arrival: { code: "CN001LHM", name: "丽江" }, departure: { code: "CN001LHM", name: "丽江" } },
        },
      },
    },
  } as any,
  productId: "77035928",
};

/** ───────── readback payload 构造 ───────── */
