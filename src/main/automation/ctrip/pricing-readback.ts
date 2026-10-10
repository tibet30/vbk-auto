import { vbkSessionRequest } from "../../infrastructure/vbk-session-request.js";
import {
  assertGroupPricingReadback,
  buildGroupPricingExpectation,
} from "./pricing-group-contract.js";
import { localBusinessDate, pricingInventoryDates } from "./pricing-api.js";
import { assertVbkAckSuccess } from "../../infrastructure/vbk-response-error.js";

const HEAD = { cid: "", ctok: "", cver: "1.0", lang: "01", sid: "8888", syscode: "09", auth: "", extension: [] };

/** Reads every still-valid pricing date. It never saves prices, stock, or group configuration. */
export async function verifyPricingInventoryReadback(page: any, product: any, productId: string) {
  const pricing = product?.commercial?.pricing;
  const inventory = product?.commercial?.inventory;
  if (!pricing || !inventory) return null;
  const dates = pricingInventoryDates(inventory.startDate, inventory.endDate, localBusinessDate());
  if (!dates.length) throw new Error("价格库存预检没有可售业务日");
  const item = await packageItem(page, productId);
  const months = [...new Set(dates.map((date) => date.slice(0, 7)))];
  const snapshots = await Promise.all(months.map((yearMonth) => readMonth(page, productId, item, yearMonth)));
  const rows = snapshots.flatMap((snapshot) => Array.isArray(snapshot.dates) ? snapshot.dates : []);
  if (Number(item.priceInputType) === 5) {
    const ageBands = await readAgeBands(page, productId, item.singleResourceId);
    const expected = buildGroupPricingExpectation(ageBands, pricing, Number(inventory.dailyQuota));
    assertGroupPricingReadback(rows, dates, expected);
  } else {
    const expectedCost = Number(pricing.cost?.adult) > 0 ? Number(pricing.cost.adult) : Number(pricing.adult);
    const matchedDates = new Set(rows.flatMap((row: any) => {
      const price = row?.adultPrice ?? row?.singleResourcePriceDtos?.[0];
      const date = String(price?.date ?? row?.base?.productDate ?? "");
      const sale = Number(price?.marketPrice ?? price?.adultSalePrice);
      return dates.includes(date)
        && Number(price?.cost ?? price?.adultCostPrice) === expectedCost
        && sale > 0
        && Number(row?.inventory?.total) === Number(inventory.dailyQuota)
        ? [date] : [];
    }));
    const missing = dates.filter((date) => !matchedDates.has(date));
    if (missing.length) throw new Error(`价格库存只读回读不完整：缺少 ${missing.length}/${dates.length} 个日期（${missing.slice(0, 6).join("、")}）`);
  }
  return { range: [inventory.startDate, dates.at(-1)], dateCount: dates.length, months };
}

async function request(page: any, path: string, body: Record<string, unknown>, label: string): Promise<any> {
  const response = await vbkSessionRequest(page, {
    endpoint: `https://online.ctrip.com/restapi/soa2/15638/${path}`,
    browserRequestTimeoutMs: 15_000,
    evaluateTimeoutMs: 20_000,
    errorLabel: label,
    body: { contentType: "json", head: HEAD, ...body },
  });
  return assertVbkAckSuccess(response.payload, label) as Record<string, unknown>;
}

async function packageItem(page: any, productId: string): Promise<any> {
  const payload = await request(page, "getPackageList", { productId: Number(productId) || productId, priceInputType: 1 }, "VBK 价格库存预检套餐读取");
  const item = Array.isArray(payload.itemList) ? payload.itemList[0] : undefined;
  if (!item?.singleResourceId || !item?.optionalResourceId) throw new Error("价格库存预检缺少套餐资源 ID");
  return item;
}

async function readMonth(page: any, productId: string, item: any, yearMonth: string): Promise<any> {
  return request(page, "GetBatchOperateSchedule", {
    packageKey: { masterResourceId: item.singleResourceId, servantResourceId: item.optionalResourceId },
    productId: Number(productId) || productId,
    yearMonth,
  }, "VBK 价格库存只读回读");
}

async function readAgeBands(page: any, productId: string, resourceId: unknown): Promise<any[]> {
  const payload = await request(page, "queryAgeBandConfig", { productId: Number(productId) || productId, resourceId }, "VBK 拼小团成团人数只读回读");
  if (!Array.isArray(payload.ageBands)) throw new Error("拼小团价格库存回读缺少年龄段配置");
  return payload.ageBands;
}
