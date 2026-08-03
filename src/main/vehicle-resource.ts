import type { Page } from "playwright";
import type { ProjectDetail } from "../shared/contracts.js";

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

function positiveInteger(value: unknown) {
  const numberValue = Number(value);
  return Number.isInteger(numberValue) && numberValue > 0 ? numberValue : undefined;
}

function positiveNumber(value: unknown) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue > 0 ? numberValue : undefined;
}

function textValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function firstText(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = textValue(record[key]);
    if (value) return value;
  }
  return undefined;
}

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

export function firstResourceGroup(payload: unknown) {
  const [record] = extractResourceGroups(payload);
  if (!record) return undefined;
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
  const selected = firstResourceGroup(payload);
  if (!selected) throw new Error(`VBK 资源库未返回与「${estimate.query}」匹配的资源组，请直接在 VBK 资源库手动核查并以 researchTasks / project 形式记录资源 ID。`);

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
    `命中 1 条资源组：${resolved.resourceGroupName}（ID ${resolved.resourceGroupId}）。`,
  ];
  if (resolved.resourceGroupMaxItemPrice !== undefined) noteParts.push(`资源组最高单价 ${resolved.resourceGroupMaxItemPrice} 元以 VBK 为准。`);
  if (existingVehicle.resourceGroupId && Number(existingVehicle.resourceGroupId) !== resolved.resourceGroupId) {
    noteParts.push("已替换先前的人工资源组 ID。");
  }
  return { product: nextProduct, resolved, note: noteParts.join(" ") };
}
