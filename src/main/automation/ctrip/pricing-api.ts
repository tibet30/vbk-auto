import { vbkSessionRequest } from "../../infrastructure/vbk-session-request.js";
import {
  VBK_GROUP_DAILY_REQUEST_INTERVAL_MS,
  assertGroupAgeBandConfig,
  assertGroupPricingReadback,
  assertPricingResponseOk,
  buildGroupPricingExpectation,
  matchingGroupPricingDates,
  retryBusyGroupRequest,
  type GroupPricingExpectation,
} from "./pricing-group-contract.js";

export {
  VBK_ASYNC_REQUEST_ACCEPTED_ERROR_CODE,
  VBK_GROUP_BUSY_RETRY_LIMIT,
  VBK_GROUP_DAILY_REQUEST_INTERVAL_MS,
} from "./pricing-group-contract.js";

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

export const VBK_MAX_PRICING_INVENTORY_DAYS = 365;

export function localBusinessDate(now = new Date()): string {
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("-");
}

export function datesBetween(start: string, end: string) {
  const dates: string[] = [];
  const cursor = new Date(`${start}T00:00:00`);
  const last = new Date(`${end}T00:00:00`);
  while (cursor <= last) {
    // 不要用 toISOString：VBK 日期是业务日，上海时区会把本地零点转成前一天 UTC。
    dates.push([
      cursor.getFullYear(),
      String(cursor.getMonth() + 1).padStart(2, "0"),
      String(cursor.getDate()).padStart(2, "0"),
    ].join("-"));
    cursor.setDate(cursor.getDate() + 1);
  }
  return dates;
}

function chunks<T>(items: T[], size: number) {
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += size) result.push(items.slice(i, i + size));
  return result;
}

async function request(page: any, path: string, body: Record<string, unknown>, label: string) {
  return vbkSessionRequest(page, {
    endpoint: `https://online.ctrip.com/restapi/soa2/15638/${path}`,
    browserRequestTimeoutMs: 15_000,
    evaluateTimeoutMs: 20_000,
    errorLabel: label,
    body,
  });
}

async function post(page: any, path: string, body: Record<string, unknown>, label: string) {
  const response = await request(page, path, body, label);
  assertPricingResponseOk(response.payload, label);
  return response.payload as any;
}

async function postGroupPriceWhenAvailable(
  page: any,
  body: Record<string, unknown>,
  pause: (milliseconds: number) => Promise<void>,
) {
  return retryBusyGroupRequest(
    () => request(page, "savePriceInventorySingleProduct", body, "VBK 拼团价格库存保存"),
    pause,
    "VBK 拼团价格库存保存",
  );
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
  // 普通价格库存接口在成本价为 0 时会把销售价一并落成 0；
  // 规划未提供成本价时，用销售价作为可提交的最低成本，确保远端售价不被平台归零。
  const adultCostPrice = Number(cost.adult) > 0 ? Number(cost.adult) : Number(pricing.adult);
  const childCostPrice = Number(cost.child) > 0 ? Number(cost.child) : Number(pricing.child);
  const priceInputType = Number(item.priceInputType);
  return {
    contentType: "json",
    head,
    priceTerms: 1,
    priceInputType,
    optionalResourceId: item.optionalResourceId,
    childOccupationBedResourceId: item.childOccupationBedResourceId,
    type: "A",
    dateChoose: { submitType: "D", dates },
    singleResourcePriceInventory: {
      price: {
        adultCostPrice,
        adultSalePrice: pricing.adult,
        chdCostPrice: childCostPrice,
        chdSalePrice: pricing.child,
      },
      inventory: { isLimit: "T", isExceed: "F", total: dailyQuota },
    },
    tourInfoId: -1,
    productId: Number(productId) || productId,
    singleResourceId: item.singleResourceId,
  };
}

function priceInventorySingleProductBody(
  productId: string,
  item: any,
  dates: string[],
  pricing: any,
  expected: GroupPricingExpectation,
) {
  const singleResourcePriceInventory = {
    adultCostPrice: expected.adultCostPrice,
    adultSalePrice: expected.adultSalePrice,
    chdCostPrice: expected.childCostPrice,
    chdSalePrice: expected.childSalePrice,
    isLimit: "T",
    isExceed: "F",
    total: expected.dailyQuota,
  };
  const cost = pricing.cost ?? {};
  const singleSupplementCost = Number(cost.singleSupplement ?? 0);
  const singleSupplementSale = Number(
    pricing.singleSupplementSale
      ?? (singleSupplementCost > 0 && Number(cost.adult) > 0
        ? Math.ceil(singleSupplementCost * Number(pricing.adult) / Number(cost.adult))
        : singleSupplementCost),
  );
  const unitPrices = expected.units.map((unit) => ({
    costPrice: unit.costPrice,
    salePrice: unit.salePrice,
    unitInfo: { ageBandId: unit.ageBandId, tierId: unit.tierId },
  }));
  const body: Record<string, unknown> = {
    productId: Number(productId) || productId,
    singleResourceId: item.singleResourceId,
    optionResourceId: item.optionalResourceId,
    childOccupationBedResourceId: item.childOccupationBedResourceId,
    priceTerms: 1,
    range: "PI",
    dateChoose: { submitType: "D", dates },
    priceOperate: "COVER",
    inventoryOperate: "COVER",
    singleResourceUnitPriceInventory: {
      singleResourceUnitPriceDtos: dates.flatMap((date) => unitPrices.map((price) => ({ ...price, date }))),
      singleResourceInventoryVO: singleResourcePriceInventory,
    },
  };
  if (item.isHotelResource === "T") {
    body.optionalResourcePriceInventory = {
      costPrice: singleSupplementCost,
      salePrice: singleSupplementSale,
      isLimit: "T",
      isExceed: "F",
      total: expected.dailyQuota,
    };
  }
  return body;
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

async function ensureSmallGroupConfig(page: any, product: any, productId: string, item: any) {
  if (Number(item.priceInputType) !== 5) return { skipped: "非拼小团套餐" };
  if (product.sales?.splitGroup !== true) throw new Error("套餐为拼小团计价，但产品未启用 sales.splitGroup。");
  const maxGroupSize = Number(product.sales.maxGroupSize ?? 8);
  if (!Number.isInteger(maxGroupSize) || maxGroupSize < 2 || maxGroupSize > 9) {
    throw new Error("拼小团最大成团人数必须是 2-9 的整数。");
  }
  const payload = await post(page, "saveAgeBandConfig", {
    productId: Number(productId) || productId,
    resourceId: item.singleResourceId,
    tiers: [
      { tierCode: "INCOMPLETE_GROUP", minPassengersRequired: 1, maxPassengersRequired: Math.max(1, maxGroupSize - 1) },
      { tierCode: "COMPLETED_GROUP", minPassengersRequired: maxGroupSize, maxPassengersRequired: maxGroupSize },
    ],
  }, "VBK 拼小团成团人数保存");
  if (payload?.resourceId == null) throw new Error("VBK 拼小团成团人数保存后缺少 resourceId 回执。");
  const saved = await post(page, "queryAgeBandConfig", {
    productId: Number(productId) || productId,
    resourceId: item.singleResourceId,
  }, "VBK 拼小团成团人数回读");
  assertGroupAgeBandConfig(saved?.ageBands, maxGroupSize);
  return { saved: true, minGroupSize: 1, maxGroupSize, ageBands: saved.ageBands ?? [] };
}

interface PricingApiOptions {
  pause?: (milliseconds: number) => Promise<void>;
}

/** 直接调用 Tour Helper 同源协议设置价格、库存，并按日期回读验证。 */
export async function ensurePricingInventoryApi(
  page: any,
  product: any,
  productId: string,
  options: PricingApiOptions = {},
) {
  const pricing = product.commercial?.pricing;
  const inventory = product.commercial?.inventory;
  if (!pricing || !inventory) throw new Error("缺少价格库存配置：commercial.pricing / commercial.inventory");
  // VBK 的价格可以接受第 366 个业务日，但库存不会落库；以库存接口的
  // 实际上限为准，避免把平台明确拒绝的最后一天误判为自动化失败。
  // 平台不会为过去的业务日落价格库存；规划与真正执行之间可能跨日。
  // 在实际写入时剔除过去日期，避免把无法写入的历史日误判为回读缺失。
  const today = localBusinessDate();
  const dates = datesBetween(inventory.startDate, inventory.endDate)
    .filter((date) => date >= today)
    .slice(0, VBK_MAX_PRICING_INVENTORY_DAYS);
  if (!dates.length) throw new Error("价格库存日期范围为空。");
  const item = await packageInfo(page, productId);
  const groupConfig = await ensureSmallGroupConfig(page, product, productId, item);
  const isByGroup = Number(item.priceInputType) === 5;
  if (isByGroup && !("ageBands" in groupConfig)) throw new Error("拼小团配置回读缺少年龄段。");
  const groupExpectation = isByGroup && "ageBands" in groupConfig
    ? buildGroupPricingExpectation(groupConfig.ageBands, pricing, inventory.dailyQuota)
    : null;
  const pause = options.pause ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  // 拼团接口在单次请求包含多个业务日时会重复合并首日 DTO；按日提交虽然
  // 往返更多，但与 VBK 前端的单日维护协议一致，避免服务端 Duplicate key。
  const chunkSize = isByGroup ? 1 : 300;
  const existingGroupDates = new Set<string>();
  if (isByGroup && groupExpectation) {
    const existingSnapshots = await Promise.all(
      [...new Set(dates.map((date) => date.slice(0, 7)))].map((month) => readMonth(page, productId, item, month)),
    );
    const existingRows = existingSnapshots.flatMap((snapshot: any) => Array.isArray(snapshot?.dates) ? snapshot.dates : []);
    for (const date of matchingGroupPricingDates(existingRows, dates, groupExpectation)) existingGroupDates.add(date);
  }
  const datesToSubmit = dates.filter((date) => !existingGroupDates.has(date));
  const dateChunks = chunks(datesToSubmit, chunkSize);
  if (isByGroup && groupExpectation) {
    for (let index = 0; index < dateChunks.length; index += 1) {
      const dateChunk = dateChunks[index];
      await postGroupPriceWhenAvailable(
        page,
        priceInventorySingleProductBody(productId, item, dateChunk, pricing, groupExpectation),
        pause,
      );
      if (index < dateChunks.length - 1) await pause(VBK_GROUP_DAILY_REQUEST_INTERVAL_MS);
    }
  } else {
    for (const dateChunk of dateChunks) {
      await post(page, "savePriceInventory", priceInventoryBody(productId, item, dateChunk, pricing, inventory.dailyQuota), "VBK 价格库存保存");
    }
  }
  const months = [...new Set(dates.map((date) => date.slice(0, 7)))];
  const snapshots = await Promise.all(months.map((month) => readMonth(page, productId, item, month)));
  const rows = snapshots.flatMap((snapshot: any) => Array.isArray(snapshot?.dates) ? snapshot.dates : []);
  const expected = new Set(dates);
  let matchedCount: number;
  if (isByGroup && groupExpectation) {
    assertGroupPricingReadback(rows, dates, groupExpectation);
    matchedCount = dates.length;
  } else {
    const matched = rows.filter((row: any) => {
      const price = row?.adultPrice ?? row?.singleResourcePriceDtos?.[0];
      const date = price?.date ?? row?.base?.productDate;
      const expectedCost = Number(pricing.cost?.adult) > 0 ? Number(pricing.cost.adult) : Number(pricing.adult);
      const effectiveSalePrice = price?.marketPrice ?? price?.adultSalePrice;
      return expected.has(date)
        && Number(price?.cost ?? price?.adultCostPrice) === expectedCost
        // 普通 VBK 价格库存会按成本价自动计算 marketPrice，不能把它误当成
        // 请求中的 salePrice；只要求远端回读为正且库存正确。
        && Number(effectiveSalePrice) > 0
        && Number(row?.inventory?.total) === Number(inventory.dailyQuota);
    });
    if (matched.length !== dates.length) {
      throw new Error(`价格库存接口回读不完整：${matched.length}/${dates.length} 个日期已匹配`);
    }
    matchedCount = matched.length;
  }
  return {
    range: [inventory.startDate, dates[dates.length - 1]],
    dailyQuota: inventory.dailyQuota,
    submitted: true,
    via: "tour-helper-api",
    dateCount: matchedCount,
    groupConfig,
  };
}
