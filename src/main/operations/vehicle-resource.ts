/**
 * VBK 用车资源组查询与匹配：
 *   - buildVehicleResourceQuery：把「城市 / 天数 / 座位 / 车级 / 时长」拼成搜索关键字；
 *   - extractResourceGroups / firstResourceGroup / bestResourceGroup：广撒网挑第一条 / 按预算挑最贴；
 *   - resolveVehicleResource：主入口，整体在 VBK 接口里选一份真实资源写入产品，
 *     永不伪造金额（这是审计点修复之一）。
 */

import type { Page } from "playwright";
import type { ProjectDetail } from "../../shared/contracts.js";

export interface VehicleResourceEstimateInput {
  city?: string;
  days?: number;
  seats?: number;
  tier?: string;
  serviceHoursPerDay?: number;
}

export interface VehicleResourceQuery {
  city: string;
  days: number;
  seats: number;
  tier: string;
  serviceHoursPerDay: number;
  query: string;
}

export interface ResolvedVehicleResource {
  query: string;
  city: string;
  days: number;
  dailyCost?: number;
  totalCost?: number;
  resourceGroupId: number;
  resourceGroupName: string;
  resourceGroupMaxItemPrice?: number;
  vehicleId?: number;
  resourceId?: number;
  vehicleModel?: string;
  resourceName?: string;
  supplierCode?: string;
}

/**
 * 把 unknown 转成正整数；非整数 / 非正数返回 undefined。
 */
function positiveInteger(value: unknown) {
  const numberValue = Number(value);
  return Number.isInteger(numberValue) && numberValue > 0 ? numberValue : undefined;
}

/**
 * 把 unknown 转成正数（含小数）；非数 / 非正数返回 undefined。
 */
function positiveNumber(value: unknown) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue > 0 ? numberValue : undefined;
}

/**
 * 把 unknown 转成 trim 后的字符串，非字符串返回 ""。
 */
function textValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * 从 record 的多个候选 key 中按顺序取第一个非空字符串。
 */
function firstText(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = textValue(record[key]);
    if (value) return value;
  }
  return undefined;
}

/**
 * 从 record 的多个候选 key 中按顺序取第一个正整数。
 */
function firstNumber(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = positiveInteger(record[key]);
    if (value) return value;
  }
  return undefined;
}

/**
 * 把城市/天数/座位/用车时长打包成 VBK 资源库查询参数。
 *
 * 之前版本会按硬编码字典 (“太原 = 400 元/天”) 拉出 estimate.dailyCost 并写
 * 进产品 operations.vehicleResource，被审计指为 “AI/UI 虚构车队价格”。
 * 这里只暴露 query、座位、时长这类 UI 能直接看懂的字段；任何给到产品 JSON
 * 的金额都来自 VBK 资源组接口的 resourceGroupMaxItemPrice。
 */
export function buildVehicleResourceQuery(input: VehicleResourceEstimateInput): VehicleResourceQuery {
  const city = textValue(input.city);
  if (!city) throw new Error("用车资源查询需要明确城市。");
  const days = positiveInteger(input.days) || 1;
  const seats = positiveInteger(input.seats) || 5;
  const tier = textValue(input.tier) || "经济";
  const serviceHoursPerDay = positiveInteger(input.serviceHoursPerDay) || 8;
  return {
    city,
    days,
    seats,
    tier,
    serviceHoursPerDay,
    query: `${seats}座${tier}`,
  };
}

/**
 * 递归遍历 payload，找到所有同时含 resourceGroupId + resourceGroupName 的对象；
 * 用 seen WeakSet 防环。返回候选数组（不解析）。
 */
export function extractResourceGroups(payload: unknown) {
  const groups: Array<Record<string, unknown>> = [];
  const seen = new Set<unknown>();

  const visit = (value: unknown) => {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }

    const record = value as Record<string, unknown>;
    const resourceGroupId = firstNumber(record, ["resourceGroupId", "resourceGroupID", "groupId", "id"]);
    const resourceGroupName = firstText(record, ["resourceGroupName", "groupName", "name", "resourceName"]);
    if (resourceGroupId && resourceGroupName) groups.push(record);
    Object.values(record).forEach(visit);
  };

  visit(payload);
  return groups;
}

/**
 * 从 payload 里取第一个资源组并解析为 ResolvedVehicleResource；找不到返回 undefined。
 * 用于「只要一个就行」的粗匹配场景。
 */
export function firstResourceGroup(payload: unknown) {
  const groups = extractResourceGroups(payload);
  if (!groups.length) return undefined;
  const [record] = groups;
  return parseResourceGroup(record);
}

/**
 * 从资源组列表中选最接近目标日租价的一项。
 * 如果没有提供 targetDailyCost 或找不到价格匹配，退回到 firstResourceGroup。
 * 搭配 20% 的容差范围（target ± 20%），超出范围的条目直接跳过。
 */
/**
 * 从 payload 资源组中按价格选最贴近 targetDailyCost 的项：
 *   - 容差 ±20%，超容差跳过；
 *   - 同等距离按价格绝对差排序；
 *   - 没传 target 时 / 没命中时退回到 firstResourceGroup。
 */
export function bestResourceGroup(payload: unknown, targetDailyCost?: number) {
  const groups = extractResourceGroups(payload);
  if (!groups.length) return undefined;
  if (!targetDailyCost || targetDailyCost <= 0) {
    const [record] = groups;
    return parseResourceGroup(record);
  }
  // 容差：目标价格的 ±20%
  const tolerance = targetDailyCost * 0.2;
  const minAcceptable = targetDailyCost - tolerance;
  const maxAcceptable = targetDailyCost + tolerance;
  // 收集所有有价格的资源组，按与目标价格的距离排序
  const priced = groups
    .flatMap((record) => {
      const parsed = parseResourceGroup(record);
      if (!parsed?.resourceGroupMaxItemPrice) return [];
      const price = parsed.resourceGroupMaxItemPrice;
      if (price < minAcceptable || price > maxAcceptable) return [];
      return [{ ...parsed, _distance: Math.abs(price - targetDailyCost) }];
    })
    .sort((a, b) => (a._distance ?? Infinity) - (b._distance ?? Infinity));
  if (priced.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { _distance, ...selected } = priced[0];
    return selected;
  }
  const [record] = groups;
  return parseResourceGroup(record);
}

/**
 * 把单个资源组记录解析为 ResolvedVehicleResource：
 *   - id / name 同时存在才返回，否则 undefined；
 *   - resourceGroupMaxItemPrice 支持多个别名（maxItemPrice / maxPrice / price）；
 *   - 其余字段视存在性选择写不写。
 */
function parseResourceGroup(record: Record<string, unknown>) {
  const resourceGroupId = firstNumber(record, ["resourceGroupId", "resourceGroupID", "groupId", "id"]);
  const resourceGroupName = firstText(record, ["resourceGroupName", "groupName", "name", "resourceName"]);
  if (!resourceGroupId || !resourceGroupName) return undefined;
  return {
    resourceGroupId,
    resourceGroupName,
    resourceGroupMaxItemPrice: positiveNumber(record.resourceGroupMaxItemPrice)
      || positiveNumber(record.maxItemPrice)
      || positiveNumber(record.maxPrice)
      || positiveNumber(record.price)
      || undefined,
    vehicleId: firstNumber(record, ["vehicleId", "carId"]),
    resourceId: firstNumber(record, ["resourceId"]),
    vehicleModel: firstText(record, ["vehicleModel", "modelName", "carModel"]),
    resourceName: firstText(record, ["resourceName", "vehicleName"]),
    supplierCode: firstText(record, ["supplierCode", "supplierProductCode", "vendorCode"]),
  };
}

/**
 * 在 VBK 页面上下文 fetch /restapi/soa2/15638/searchResourceGroup，参数为 resourceGroupName（座位+车型）。
 * 按 cid 拼 x-traceID，回 raw payload（JSON.parse 失败保留文本），非 2xx 抛错。
 */
export async function searchVehicleResourceGroups(page: Page, query: string) {
  return page.evaluate(async ({ query: resourceGroupName }) => {
    const readCookie = (name: string) => {
      const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
      return match ? decodeURIComponent(match[1]) : "";
    };
    const cid = readCookie("GUID") || readCookie("vbk_login_cid") || `${Date.now()}`;
    const trace = `${cid}-${Date.now()}-${Math.floor(Math.random() * 10_000_000)}`;
    const response = await fetch(`https://online.ctrip.com/restapi/soa2/15638/searchResourceGroup?x-traceID=${encodeURIComponent(trace)}`, {
      method: "POST",
      credentials: "include",
      headers: {
        accept: "*/*",
        "content-type": "application/json",
        "x-ctx-currency": "CNY",
        "x-ctx-locale": "zh-CN",
      },
      body: JSON.stringify({
        contentType: "json",
        head: {
          cid,
          ctok: "",
          cver: "1.0",
          lang: "01",
          sid: "8888",
          syscode: "09",
          auth: "",
          xsid: "",
          extension: [],
        },
        resourceGroupName,
        pageNo: 1,
        pageSize: 10,
      }),
    });
    const text = await response.text();
    let payload: unknown = text;
    try { payload = JSON.parse(text); } catch { /* keep raw text for diagnostics */ }
    if (!response.ok) throw new Error(`VBK 资源组搜索失败：HTTP ${response.status} ${text.slice(0, 160)}`);
    return payload;
  }, { query });
}

/**
 * 主入口：用 VBK 资源组搜索接口为 project 找一份车辆资源；
 *   - 拿 estimate（城市/天数/座位/车级）→ 接口查询 → bestResourceGroup 选最佳；
 *   - 未命中时退而求其次用「仅座位数」再次搜索；
 *   - 仍未命中则保留原 product，加 note 说明，让运营人工干预；
 *   - 命中时把资源组真实价格（resourceGroupMaxItemPrice）写入 operations.vehicleResource，
 *     永不伪造金额（这是之前被审计为虚构车队价格的修复点）。
 */
export async function resolveVehicleResource(page: Page, project: ProjectDetail) {
  const product = project.product;
  const basic = product.basicInfo && typeof product.basicInfo === "object" && !Array.isArray(product.basicInfo) ? product.basicInfo as Record<string, unknown> : {};
  const operations = product.operations && typeof product.operations === "object" && !Array.isArray(product.operations) ? product.operations as Record<string, unknown> : {};
  const existingVehicle = operations.vehicleResource && typeof operations.vehicleResource === "object" && !Array.isArray(operations.vehicleResource)
    ? operations.vehicleResource as Record<string, unknown>
    : {};
  const estimate = buildVehicleResourceQuery({
    city: textValue(operations.pickupCity) || textValue(basic.meetingCity) || textValue(basic.destinationCity),
    days: positiveInteger(basic.days),
    serviceHoursPerDay: positiveInteger(existingVehicle.serviceHoursPerDay) || 8,
  });
  const payload = await searchVehicleResourceGroups(page, estimate.query);
  // 从产品定价中推算每日用车预算（成人价 × 起订人数 × 约 25% 分配给用车 ÷ 天数）。
  const commercial = product.commercial && typeof product.commercial === "object" && !Array.isArray(product.commercial) ? product.commercial as Record<string, unknown> : {};
  const pricing = commercial.pricing && typeof commercial.pricing === "object" && !Array.isArray(commercial.pricing) ? commercial.pricing as Record<string, unknown> : {};
  const adultPrice = positiveNumber(pricing.adult) || 0;
  const minTravelers = positiveInteger(pricing.minimumTravelers) || 2;
  const tripDays = positiveInteger(basic.days) || 1;
  const targetDailyCost = adultPrice > 0 ? Math.round((adultPrice * minTravelers * 0.25) / tripDays) : undefined;
  // 如果精准查询无结果，退而求其次用更宽泛的关键词重试（去掉车级）。
  let selected = bestResourceGroup(payload, targetDailyCost);
  if (!selected) {
    const fallbackQuery = `${estimate.seats}座`; // 去掉车级（经济/舒适），只用座位数
    if (fallbackQuery !== estimate.query) {
      const fallbackPayload = await searchVehicleResourceGroups(page, fallbackQuery);
      selected = bestResourceGroup(fallbackPayload, targetDailyCost);
      if (selected) {
        console.info("[VehicleResource] matched via fallback query", { original: estimate.query, fallback: fallbackQuery, resourceGroupId: selected.resourceGroupId });
      }
    }
  }
  if (!selected) {
    // 车辆资源库无匹配项：产品退回原样，备注说明情况。不抛异常——运营可后续人工匹配。
    return {
      product: { ...product, operations: { ...operations, transport: operations.transport || "charter" } },
      resolved: undefined,
      note: `VBK 资源库未返回与「${estimate.query}」匹配的车辆资源组，请人工在 VBK 核查或调整搜索关键词后重试。`,
    };
  }

  // 资源组价格等运营字段只接受来自 VBK 资源库接口的真实值；接口未返回就
  // 留空，UI 那边会要求运营人员从 VBK 复制金额补全。
  const resolved: ResolvedVehicleResource = {
    query: estimate.query,
    city: estimate.city,
    days: estimate.days,
    resourceGroupId: selected.resourceGroupId,
    resourceGroupName: selected.resourceGroupName,
    resourceGroupMaxItemPrice: selected.resourceGroupMaxItemPrice,
    vehicleId: selected.vehicleId,
    resourceId: selected.resourceId,
    vehicleModel: selected.vehicleModel,
    resourceName: selected.resourceName,
    supplierCode: selected.supplierCode,
  };
  const vehicleResource = {
    ...existingVehicle,
    resourceGroupId: resolved.resourceGroupId,
    resourceGroupName: resolved.resourceGroupName,
    ...(resolved.resourceGroupMaxItemPrice !== undefined ? { resourceGroupMaxItemPrice: resolved.resourceGroupMaxItemPrice } : {}),
    serviceHoursPerDay: estimate.serviceHoursPerDay,
    serviceKilometersPerDay: positiveInteger(existingVehicle.serviceKilometersPerDay) || 300,
    ...(resolved.vehicleId ? { vehicleId: resolved.vehicleId } : {}),
    ...(resolved.resourceId ? { resourceId: resolved.resourceId } : {}),
    ...(resolved.vehicleModel ? { vehicleModel: resolved.vehicleModel } : {}),
    ...(resolved.resourceName ? { resourceName: resolved.resourceName } : {}),
    ...(resolved.supplierCode ? { supplierCode: resolved.supplierCode } : {}),
  };
  const nextProduct = {
    ...product,
    operations: {
      ...operations,
      transport: operations.transport || "charter",
      pickupCity: textValue(operations.pickupCity) || estimate.city,
      reusePickupForDropoff: typeof operations.reusePickupForDropoff === "boolean" ? operations.reusePickupForDropoff : true,
      vehicleResource,
    },
  };
  const noteParts: string[] = [
    `${estimate.city}${estimate.days}天私家团按${estimate.query}、每天${estimate.serviceHoursPerDay}小时在 VBK 资源库搜索。`,
  ];
  if (targetDailyCost && resolved.resourceGroupMaxItemPrice) {
    noteParts.push(`预算约 ${targetDailyCost} 元/天，命中资源组最高单价 ${resolved.resourceGroupMaxItemPrice} 元（ID ${resolved.resourceGroupId}）。`);
  } else {
    noteParts.push(`命中资源组：${resolved.resourceGroupName}（ID ${resolved.resourceGroupId}）。`);
  }
  if (resolved.resourceGroupMaxItemPrice !== undefined && !targetDailyCost) noteParts.push(`资源组最高单价 ${resolved.resourceGroupMaxItemPrice} 元以 VBK 为准。`);
  if (existingVehicle.resourceGroupId && Number(existingVehicle.resourceGroupId) !== resolved.resourceGroupId) {
    noteParts.push("已替换先前的人工资源组 ID。");
  }
  return { product: nextProduct, resolved, note: noteParts.join(" ") };
}
