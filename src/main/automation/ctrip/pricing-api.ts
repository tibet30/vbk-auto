import { vbkSessionRequest } from "../../infrastructure/vbk-session-request.js";

const head = {
  cid: "",
  ctok: "",
  cver: "1.0",
  lang: "01",
  sid: "8888",
  syscode: "09",
  auth: "",
  extension: [],
};

function assertOk(payload: any, label: string) {
  const status = payload?.ResponseStatus;
  if (status?.Ack === "Failure" || (Array.isArray(status?.Errors) && status.Errors.length)) {
    throw new Error(`${label}失败：${JSON.stringify(status.Errors ?? status).slice(0, 500)}`);
  }
}

function datesBetween(start: string, end: string) {
  const dates: string[] = [];
  const cursor = new Date(`${start}T00:00:00`);
  const last = new Date(`${end}T00:00:00`);
  while (cursor <= last) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setDate(cursor.getDate() + 1);
  }
  return dates;
}

function chunks<T>(items: T[], size: number) {
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += size) result.push(items.slice(i, i + size));
  return result;
}

async function post(page: any, path: string, body: Record<string, unknown>, label: string) {
  const response = await vbkSessionRequest(page, {
    endpoint: `https://online.ctrip.com/restapi/soa2/15638/${path}`,
    browserRequestTimeoutMs: 15_000,
    evaluateTimeoutMs: 20_000,
    errorLabel: label,
    body,
  });
  assertOk(response.payload, label);
  return response.payload as any;
}

async function packageInfo(page: any, productId: string) {
  const payload = await post(page, "getPackageList", {
    contentType: "json",
    head,
    productId: Number(productId) || productId,
    priceInputType: 1,
  }, "VBK 套餐资源查询");
  const item = Array.isArray(payload?.itemList) ? payload.itemList[0] : undefined;
  if (!item?.singleResourceId || !item?.optionalResourceId) {
    throw new Error("价格库存接口缺少套餐资源 ID，请先保存套餐管理。");
  }
  return item;
}

function priceInventoryBody(productId: string, item: any, dates: string[], pricing: any, dailyQuota: number) {
  const cost = pricing.cost ?? {
    adult: pricing.adult,
    child: pricing.child,
    singleSupplement: 0,
    childBed: 0,
  };
  return {
    contentType: "json",
    head,
    priceTerms: 1,
    priceInputType: 1,
    optionalResourceId: item.optionalResourceId,
    type: "A",
    dateChoose: { submitType: "D", dates },
    singleResourcePriceInventory: {
      price: {
        adultCostPrice: cost.adult,
        adultSalePrice: pricing.adult,
        chdCostPrice: cost.child,
        chdSalePrice: pricing.child,
      },
      inventory: { isLimit: "T", isExceed: "F", total: dailyQuota },
    },
    tourInfoId: -1,
    productId: Number(productId) || productId,
    singleResourceId: item.singleResourceId,
  };
}

async function readMonth(page: any, productId: string, item: any, yearMonth: string) {
  return post(page, "GetBatchOperateSchedule", {
    contentType: "json",
    head,
    packageKey: { masterResourceId: item.singleResourceId, servantResourceId: item.optionalResourceId },
    productId: Number(productId) || productId,
    yearMonth,
  }, "VBK 价格库存回读");
}

/** 直接调用 Tour Helper 同源协议设置价格、库存，并按日期回读验证。 */
export async function ensurePricingInventoryApi(page: any, product: any, productId: string) {
  const pricing = product.commercial?.pricing;
  const inventory = product.commercial?.inventory;
  if (!pricing || !inventory) throw new Error("缺少价格库存配置：commercial.pricing / commercial.inventory");
  const dates = datesBetween(inventory.startDate, inventory.endDate);
  if (!dates.length) throw new Error("价格库存日期范围为空。");
  const item = await packageInfo(page, productId);
  for (const dateChunk of chunks(dates, 300)) {
    const payload = await post(page, "savePriceInventory", priceInventoryBody(productId, item, dateChunk, pricing, inventory.dailyQuota), "VBK 价格库存保存");
    assertOk(payload, "VBK 价格库存保存");
  }
  const months = [...new Set(dates.map((date) => date.slice(0, 7)))];
  const snapshots = await Promise.all(months.map((month) => readMonth(page, productId, item, month)));
  const rows = snapshots.flatMap((snapshot: any) => Array.isArray(snapshot?.dates) ? snapshot.dates : []);
  const expected = new Set(dates);
  const matched = rows.filter((row: any) => expected.has(row?.adultPrice?.date)
    && Number(row?.adultPrice?.cost) === Number(pricing.cost?.adult ?? pricing.adult)
    && Number(row?.inventory?.total) === Number(inventory.dailyQuota));
  if (matched.length !== dates.length) {
    throw new Error(`价格库存接口回读不完整：${matched.length}/${dates.length} 个日期已匹配`);
  }
  return { range: [inventory.startDate, inventory.endDate], dailyQuota: inventory.dailyQuota, submitted: true, via: "tour-helper-api", dateCount: matched.length };
}
