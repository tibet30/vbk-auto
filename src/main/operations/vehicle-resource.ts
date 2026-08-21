/**
 * VBK 用车资源组查询与匹配：
 *   - buildVehicleResourceQuery：把「城市 / 天数 / 座位 / 车级 / 时长」拼成搜索关键字；
 *   - extractResourceGroups / firstResourceGroup / bestResourceGroup：广撒网挑第一条 / 按预算挑最贴；
 *   - resolveVehicleResource：主入口，整体在 VBK 接口里选一份真实资源组写入产品。
 */

import type { Page } from "playwright";
import type { ProductDetail } from "../../shared/contracts.js";
import { vbkSessionRequest } from "../infrastructure/vbk-session-request.js";
import { logInfo } from "../../shared/log-timestamp.js";

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
  totalCost?: number;
  resourceGroupId: number;
  resourceGroupName: string;
}

/** 把 unknown 转成正整数；非整数 / 非正数返回 undefined。 */
function positiveInteger(value: unknown) {
  const numberValue = Number(value);
  return Number.isInteger(numberValue) && numberValue > 0 ? numberValue : undefined;
}

function positiveNumber(value: unknown) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue > 0 ? numberValue : undefined;
}

function roundUpVehicleTotalCost(value: number) {
  return Math.ceil(value / 50) * 50;
}

/** 把 unknown 转成 trim 后的字符串，非字符串返回 ""。 */
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

/** 把城市/天数/座位/用车时长打包成 VBK 资源库查询参数。 */
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

export function targetVehicleTotalCost(product: Record<string, unknown>): number | undefined {
  const operations = product.operations && typeof product.operations === "object" && !Array.isArray(product.operations) ? product.operations as Record<string, unknown> : {};
  const vehicle = operations.vehicleResource && typeof operations.vehicleResource === "object" && !Array.isArray(operations.vehicleResource)
    ? operations.vehicleResource as Record<string, unknown>
    : {};
  // 用户曾在 UI 上清空过「全程预计用车总成本」——尊重这个意图，不再自动填充。
  if (vehicle.requestedTotalCostCleared === true || vehicle.requestedDailyCostCleared === true) return undefined;
  const requestedTotalCost = positiveNumber(vehicle.requestedTotalCost);
  if (requestedTotalCost) return roundUpVehicleTotalCost(requestedTotalCost);
  // 历史产品把成本保存为日价。读取时按产品天数一次性换算为总价；
  // 新的规划和人工保存不再写 requestedDailyCost。
  const legacyDailyCost = positiveNumber(vehicle.requestedDailyCost);
  const basic = product.basicInfo && typeof product.basicInfo === "object" && !Array.isArray(product.basicInfo)
    ? product.basicInfo as Record<string, unknown>
    : {};
  const days = positiveInteger(basic.days) || 1;
  if (legacyDailyCost) return roundUpVehicleTotalCost(legacyDailyCost * days);
  return undefined;
}

function sanitiseVehicleResource(value: Record<string, unknown>, totalCost?: number) {
  const safeVehicle: Record<string, unknown> = {};
  const requestedTotalCost = positiveNumber(value.requestedTotalCost) || totalCost;
  const resourceGroupId = positiveInteger(value.resourceGroupId);
  const resourceGroupName = textValue(value.resourceGroupName);
  const serviceHoursPerDay = positiveInteger(value.serviceHoursPerDay);
  const serviceKilometersPerDay = positiveInteger(value.serviceKilometersPerDay);
  if (value.requestedTotalCostCleared === true || value.requestedDailyCostCleared === true) safeVehicle.requestedTotalCostCleared = true;
  if (requestedTotalCost) safeVehicle.requestedTotalCost = requestedTotalCost;
  if (resourceGroupId) safeVehicle.resourceGroupId = resourceGroupId;
  if (resourceGroupName) safeVehicle.resourceGroupName = resourceGroupName;
  if (serviceHoursPerDay) safeVehicle.serviceHoursPerDay = serviceHoursPerDay;
  if (serviceKilometersPerDay) safeVehicle.serviceKilometersPerDay = serviceKilometersPerDay;
  return safeVehicle;
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
    const resourceGroupName = firstText(record, ["resourceGroupName", "groupName", "name"]);
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

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalisedText(value: string) {
  return value.replace(/\s+/g, "");
}

/**
 * 从资源组名称中临时解析车型价格，仅用于选择最接近全程总价，不写回 product JSON。
 * 例如：
 *   - "5座经济1000+5座舒适1100" + "5座经济" => 1000
 *   - "5座舒适1000" + "5座舒适" => 1000
 */
export function parseVehicleResourceGroupNamePrice(resourceGroupName: string, preferredLabel?: string) {
  const name = normalisedText(resourceGroupName);
  const label = preferredLabel ? normalisedText(preferredLabel) : "";
  if (!name) return undefined;
  if (label) {
    const labelPrice = name.match(new RegExp(`${escapeRegExp(label)}[^0-9]{0,12}(\\d{2,6})(?:\\D|$)`));
    if (labelPrice) return positiveNumber(labelPrice[1]);
  }
  const prices = Array.from(name.matchAll(/(?:^|\D)(\d{2,6})(?:\D|$)/g))
    .map((match) => positiveNumber(match[1]))
    .filter((value): value is number => value !== undefined);
  return prices[0];
}

export function bestResourceGroup(payload: unknown, targetTotalCost?: number, preferredLabel?: string) {
  const groups = extractResourceGroups(payload);
  if (!groups.length) return undefined;
  if (!targetTotalCost || targetTotalCost <= 0) {
    const [record] = groups;
    return parseResourceGroup(record);
  }
  // 容差：目标价格的 ±20%
  const tolerance = targetTotalCost * 0.2;
  const minAcceptable = targetTotalCost - tolerance;
  const maxAcceptable = targetTotalCost + tolerance;
  // 收集所有有价格的资源组，按与目标价格的距离排序
  let hasParsedPrice = false;
  const priced = groups
    .flatMap((record) => {
      const parsed = parseResourceGroup(record);
      if (!parsed) return [];
      const price = parseVehicleResourceGroupNamePrice(parsed.resourceGroupName, preferredLabel)
        || positiveNumber(record.resourceGroupMaxItemPrice)
        || positiveNumber(record.maxItemPrice)
        || positiveNumber(record.maxPrice)
        || positiveNumber(record.price);
      if (!price) return [];
      hasParsedPrice = true;
      if (price < minAcceptable || price > maxAcceptable) return [];
      return [{ ...parsed, _distance: Math.abs(price - targetTotalCost) }];
    })
    .sort((a, b) => (a._distance ?? Infinity) - (b._distance ?? Infinity));
  if (priced.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { _distance, ...selected } = priced[0];
    return selected;
  }
  if (hasParsedPrice) return undefined;
  const [record] = groups;
  return parseResourceGroup(record);
}

/**
 * 把单个资源组记录解析为 ResolvedVehicleResource：
 *   - id / name 同时存在才返回，否则 undefined；
 */
function parseResourceGroup(record: Record<string, unknown>) {
  const resourceGroupId = firstNumber(record, ["resourceGroupId", "resourceGroupID", "groupId", "id"]);
  const resourceGroupName = firstText(record, ["resourceGroupName", "groupName", "name"]);
  if (!resourceGroupId || !resourceGroupName) return undefined;
  return {
    resourceGroupId,
    resourceGroupName,
  };
}

/**
 * 在 VBK 页面上下文 fetch /restapi/soa2/15638/searchResourceGroup，参数为 resourceGroupName（座位+车型）。
 * 按 cid 拼 x-traceID，返回解析后的安全 payload，非 2xx / 非 JSON 都明确抛错。
 */
export async function searchVehicleResourceGroups(page: Page, query: string) {
  const response = await vbkSessionRequest(page, {
    endpoint: "https://online.ctrip.com/restapi/soa2/15638/searchResourceGroup",
    browserRequestTimeoutMs: 12_000,
    evaluateTimeoutMs: 15_000,
    errorLabel: "VBK 资源组搜索",
    body: {
      contentType: "json",
      head: {
        cid: "",
        ctok: "",
        cver: "1.0",
        lang: "01",
        sid: "8888",
        syscode: "09",
        auth: "",
        xsid: "",
        extension: [],
      },
      resourceGroupName: query,
      pageNo: 1,
      pageSize: 10,
    },
  });
  return response.payload;
}

/**
 * 主入口：用 VBK 资源组搜索接口为 product 找一份车辆资源；
 *   - 拿 estimate（城市/天数/座位/车级）→ 接口查询 → bestResourceGroup 选最佳；
 *   - 未命中时退而求其次用「仅座位数」再次搜索；
 *   - 仍未命中则保留全程用车总成本但清掉旧匹配结果，加 note 说明，让运营人工干预；
 *   - 命中时只把真实可用的资源组 ID / 名称写入 operations.vehicleResource。
 */
export async function resolveVehicleResource(page: Page, product: ProductDetail) {
  const productData = product.product;
  const basic = productData.basicInfo && typeof productData.basicInfo === "object" && !Array.isArray(productData.basicInfo) ? productData.basicInfo as Record<string, unknown> : {};
  const operations = productData.operations && typeof productData.operations === "object" && !Array.isArray(productData.operations) ? productData.operations as Record<string, unknown> : {};
  const existingVehicle = operations.vehicleResource && typeof operations.vehicleResource === "object" && !Array.isArray(operations.vehicleResource)
    ? operations.vehicleResource as Record<string, unknown>
    : {};
  const estimate = buildVehicleResourceQuery({
    city: textValue(operations.pickupCity) || textValue(basic.meetingCity) || textValue(basic.destinationCity),
    days: positiveInteger(basic.days),
    serviceHoursPerDay: positiveInteger(existingVehicle.serviceHoursPerDay) || 8,
  });
  const targetTotalCost = targetVehicleTotalCost(productData);
  const primaryQuery = targetTotalCost ? `${estimate.query}${targetTotalCost}` : estimate.query;
  const payload = await searchVehicleResourceGroups(page, primaryQuery);
  // 如果精准查询无结果，退而求其次用更宽泛的关键词重试（去掉车级）。
  let selected = bestResourceGroup(payload, targetTotalCost, estimate.query);
  let matchedQuery = primaryQuery;
  if (!selected) {
    const fallbackQuery = `${estimate.seats}座`; // 去掉车级（经济/舒适），只用座位数
    if (fallbackQuery !== estimate.query) {
      const fallbackSearchQuery = targetTotalCost ? `${fallbackQuery}${targetTotalCost}` : fallbackQuery;
      const fallbackPayload = await searchVehicleResourceGroups(page, fallbackSearchQuery);
      selected = bestResourceGroup(fallbackPayload, targetTotalCost, estimate.query);
      if (selected) {
        matchedQuery = fallbackSearchQuery;
        logInfo("[VehicleResource] matched via fallback query", { original: primaryQuery, fallback: fallbackSearchQuery, resourceGroupId: selected.resourceGroupId });
      }
    }
  }
  if (!selected) {
    const {
      resourceGroupId: _oldResourceGroupId,
      resourceGroupName: _oldResourceGroupName,
      ...safeExistingVehicle
    } = sanitiseVehicleResource(existingVehicle, targetTotalCost);
    // 车辆资源库无匹配项：保留全程用车总成本 / 服务参数，但清掉旧 ID/Name，避免用户误以为新价格已匹配成功。
    return {
      product: {
        ...productData,
        operations: {
          ...operations,
          transport: operations.transport || "charter",
          vehicleResource: safeExistingVehicle,
        },
      },
      resolved: undefined,
      note: `VBK 资源库未返回与「${primaryQuery}」匹配的车辆资源组，请人工在 VBK 核查或调整搜索关键词后重试。`,
    };
  }

  const resolved: ResolvedVehicleResource = {
    query: matchedQuery,
    city: estimate.city,
    days: estimate.days,
    totalCost: targetTotalCost,
    resourceGroupId: selected.resourceGroupId,
    resourceGroupName: selected.resourceGroupName,
  };
  const {
    resourceGroupId: _oldResourceGroupId,
    resourceGroupName: _oldResourceGroupName,
    ...safeExistingVehicle
  } = sanitiseVehicleResource(existingVehicle, targetTotalCost);
  const vehicleResource = {
    ...safeExistingVehicle,
    resourceGroupId: resolved.resourceGroupId,
    resourceGroupName: resolved.resourceGroupName,
    serviceHoursPerDay: estimate.serviceHoursPerDay,
    serviceKilometersPerDay: positiveInteger(existingVehicle.serviceKilometersPerDay) || 300,
  };
  const nextProduct = {
    ...productData,
    operations: {
      ...operations,
      transport: operations.transport || "charter",
      pickupCity: textValue(operations.pickupCity) || estimate.city,
      reusePickupForDropoff: typeof operations.reusePickupForDropoff === "boolean" ? operations.reusePickupForDropoff : true,
      vehicleResource,
    },
  };
  const noteParts: string[] = [
    `${estimate.city}${estimate.days}天私家团按${matchedQuery}、每天${estimate.serviceHoursPerDay}小时在 VBK 资源库搜索。`,
  ];
  if (targetTotalCost) noteParts.push(`全程用车预算约 ${targetTotalCost} 元，按总价命中资源组：${resolved.resourceGroupName}（ID ${resolved.resourceGroupId}）。`);
  else noteParts.push(`命中资源组：${resolved.resourceGroupName}（ID ${resolved.resourceGroupId}）。`);
  if (existingVehicle.resourceGroupId && Number(existingVehicle.resourceGroupId) !== resolved.resourceGroupId) {
    noteParts.push("已替换先前的人工资源组 ID。");
  }
  return { product: nextProduct, resolved, note: noteParts.join(" ") };
}
