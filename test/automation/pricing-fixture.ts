import assert from "node:assert/strict";
import {localBusinessDate} from "../../src/main/automation/ctrip/pricing-api.js";

export const success = { ResponseStatus: { Ack: "Success", Errors: [] } };
export const ageBands = [
  {
    ageBandId: 11,
    ageBandCode: "ADULT",
    tiers: [
      { tierId: 101, tierCode: "INCOMPLETE_GROUP", minPassengersRequired: 1, maxPassengersRequired: 7 },
      { tierId: 102, tierCode: "COMPLETED_GROUP", minPassengersRequired: 8, maxPassengersRequired: 8 },
    ],
  },
  {
    ageBandId: 22,
    ageBandCode: "CHILD",
    tiers: [
      { tierId: 201, tierCode: "INCOMPLETE_GROUP", minPassengersRequired: 1, maxPassengersRequired: 7 },
      { tierId: 202, tierCode: "COMPLETED_GROUP", minPassengersRequired: 8, maxPassengersRequired: 8 },
    ],
  },
];
export const firstDate = localBusinessDate();
const nextBusinessDay = new Date();
nextBusinessDay.setDate(nextBusinessDay.getDate() + 1);
export const secondDate = localBusinessDate(nextBusinessDay);
export const product = {
  commercial: {
    pricing: { adult: 1_000, child: 600 },
    inventory: { startDate: firstDate, endDate: secondDate, dailyQuota: 8 },
  },
  sales: { splitGroup: true, maxGroupSize: 8 },
};

type BrowserCall = { path: string; body: any };

export function browserWithHandler(handler: (path: string, body: any, calls: BrowserCall[]) => any) {
  const calls: BrowserCall[] = [];
  return {
    calls,
    async evaluate(_fn: unknown, args: { endpoint: string; body: any }) {
      const path = new URL(args.endpoint).pathname.split("/").pop() ?? "";
      calls.push({ path, body: args.body });
      const payload = await handler(path, args.body, calls);
      return { status: 200, payload, durationMs: 1, ctx: {} };
    },
  };
}

export function rowsFromSaveBody(body: any) {
  const inventory = body.singleResourceUnitPriceInventory.singleResourceInventoryVO;
  const units = body.singleResourceUnitPriceInventory.singleResourceUnitPriceDtos;
  assert.equal(units.length, 4);
  assert.ok(units.every((unit: any) => unit.date === body.dateChoose.dates[0]));
  return body.dateChoose.dates.map((date: string) => ({
    productDate: date, inventory: {total: inventory.total},
    singleResourceUnitPriceDtos: units.map((unit: any) => ({...unit, date})),
  }));
}

export function baseEndpointPayload(path: string) {
  if (path === "getPackageList") {
    return {
      ...success,
      itemList: [{
        singleResourceId: 7001,
        optionalResourceId: 8001,
        childOccupationBedResourceId: 9001,
        priceInputType: 5,
        isHotelResource: "F",
      }],
    };
  }
  if (path === "saveAgeBandConfig") return { ...success, resourceId: 7001 };
  if (path === "queryAgeBandConfig") return { ...success, ageBands };
  return null;
}

