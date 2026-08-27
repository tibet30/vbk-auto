export const VBK_GROUP_DAILY_REQUEST_INTERVAL_MS = 250;
export const VBK_ASYNC_REQUEST_ACCEPTED_ERROR_CODE = "20018030";
export const VBK_GROUP_BUSY_RETRY_LIMIT = 20;

type ApiError = { ErrorCode?: unknown; Message?: unknown };

export type PricingResponseClassification =
  | { kind: "success" }
  | { kind: "busy"; errors: ApiError[] }
  | { kind: "failure"; errors: ApiError[]; status: unknown };

export class VbkPricingResponseError extends Error {
  readonly errorCodes: string[];

  constructor(label: string, classification: Extract<PricingResponseClassification, { kind: "failure" }>) {
    super(`${label}失败：${JSON.stringify(classification.errors.length ? classification.errors : classification.status).slice(0, 500)}`);
    this.name = "VbkPricingResponseError";
    this.errorCodes = classification.errors.map((error) => String(error?.ErrorCode ?? ""));
  }
}

export function classifyPricingResponse(payload: any): PricingResponseClassification {
  const status = payload?.ResponseStatus;
  const errors: ApiError[] = Array.isArray(status?.Errors) ? status.Errors : [];
  const failed = status?.Ack === "Failure" || errors.length > 0;
  if (!failed) return { kind: "success" };
  if (errors.length > 0
    && errors.every((error) => String(error?.ErrorCode ?? "") === VBK_ASYNC_REQUEST_ACCEPTED_ERROR_CODE)) {
    return { kind: "busy", errors };
  }
  return { kind: "failure", errors, status };
}

export function assertPricingResponseOk(payload: any, label: string): void {
  const classification = classifyPricingResponse(payload);
  if (classification.kind === "success") return;
  if (classification.kind === "busy") {
    throw new VbkPricingResponseError(label, {
      kind: "failure",
      errors: classification.errors,
      status: payload?.ResponseStatus,
    });
  }
  throw new VbkPricingResponseError(label, classification);
}

export async function retryBusyGroupRequest<T>(
  request: () => Promise<{ payload: T }>,
  pause: (milliseconds: number) => Promise<void>,
  label: string,
  retryLimit = VBK_GROUP_BUSY_RETRY_LIMIT,
): Promise<T> {
  for (let attempt = 1; attempt <= retryLimit; attempt += 1) {
    const response = await request();
    const classification = classifyPricingResponse(response.payload);
    if (classification.kind === "success") return response.payload;
    if (classification.kind !== "busy") throw new VbkPricingResponseError(label, classification);
    if (attempt === retryLimit) {
      throw new VbkPricingResponseError(`${label}（等待平台写锁超时）`, {
        kind: "failure",
        errors: classification.errors,
        status: (response.payload as any)?.ResponseStatus,
      });
    }
    await pause(VBK_GROUP_DAILY_REQUEST_INTERVAL_MS);
  }
  throw new Error(`${label}等待平台写锁超时`);
}

export interface GroupUnitPriceExpectation {
  ageBandId: unknown;
  tierId: unknown;
  ageBandCode: "ADULT" | "CHILD";
  tierCode: "INCOMPLETE_GROUP" | "COMPLETED_GROUP";
  costPrice: number;
  salePrice: number;
}

export interface GroupPricingExpectation {
  adultCostPrice: number;
  adultSalePrice: number;
  childCostPrice: number;
  childSalePrice: number;
  dailyQuota: number;
  units: GroupUnitPriceExpectation[];
}

function requireFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label}必须是有限数字。`);
  return value;
}

function requirePositive(value: unknown, label: string): number {
  const parsed = requireFiniteNumber(value, label);
  if (parsed <= 0) throw new Error(`${label}必须大于 0。`);
  return parsed;
}

function effectiveCost(rawCost: unknown, salePrice: number, label: string): number {
  if (rawCost == null || rawCost === 0) return salePrice;
  return requirePositive(rawCost, label);
}

function requireId(value: unknown, label: string): unknown {
  if (value == null || String(value).trim() === "") throw new Error(`${label}缺失。`);
  return value;
}

interface ValidatedAgeBand {
  ageBandId: unknown;
  ageBandCode: "ADULT" | "CHILD";
  tiers: Array<{
    tierId: unknown;
    tierCode: "INCOMPLETE_GROUP" | "COMPLETED_GROUP";
    minPassengersRequired: unknown;
    maxPassengersRequired: unknown;
  }>;
}

function validateGroupAgeBands(ageBands: any[]): ValidatedAgeBand[] {
  if (!Array.isArray(ageBands) || ageBands.length === 0) throw new Error("VBK 拼小团年龄段配置为空。");
  const ageBandIds = new Set<string>();
  const ageBandCodes = new Set<string>();
  const unitIds = new Set<string>();
  const validated = ageBands.map((band) => {
    const ageBandId = requireId(band?.ageBandId, "VBK 拼小团 ageBandId");
    const ageBandIdKey = String(ageBandId);
    const ageBandCode = String(band?.ageBandCode ?? "");
    if (ageBandCode !== "ADULT" && ageBandCode !== "CHILD") {
      throw new Error(`VBK 拼小团存在不支持的年龄段：${ageBandCode || "<空>"}。`);
    }
    if (ageBandIds.has(ageBandIdKey) || ageBandCodes.has(ageBandCode)) {
      throw new Error(`VBK 拼小团年龄段重复：${ageBandCode}/${ageBandIdKey}。`);
    }
    ageBandIds.add(ageBandIdKey);
    ageBandCodes.add(ageBandCode);
    const rawTiers = Array.isArray(band?.tiers) ? band.tiers : [];
    if (rawTiers.length !== 2) throw new Error(`VBK 拼小团年龄段 ${ageBandCode} 必须恰好包含两个价格层级。`);
    const tierCodes = new Set<string>();
    const tiers = rawTiers.map((tier: any) => {
      const tierId = requireId(tier?.tierId, `VBK 拼小团 ${ageBandCode} tierId`);
      const tierCode = String(tier?.tierCode ?? "");
      if (tierCode !== "INCOMPLETE_GROUP" && tierCode !== "COMPLETED_GROUP") {
        throw new Error(`VBK 拼小团存在不支持的价格层级：${tierCode || "<空>"}。`);
      }
      const unitId = groupUnitKey(ageBandId, tierId);
      if (tierCodes.has(tierCode) || unitIds.has(unitId)) {
        throw new Error(`VBK 拼小团年龄段/层级重复：${ageBandCode}/${tierCode}/${unitId}。`);
      }
      tierCodes.add(tierCode);
      unitIds.add(unitId);
      return {
        tierId,
        tierCode,
        minPassengersRequired: tier?.minPassengersRequired,
        maxPassengersRequired: tier?.maxPassengersRequired,
      };
    });
    if (!tierCodes.has("INCOMPLETE_GROUP") || !tierCodes.has("COMPLETED_GROUP")) {
      throw new Error(`VBK 拼小团年龄段 ${ageBandCode} 缺少未成团或已成团层级。`);
    }
    return { ageBandId, ageBandCode, tiers } as ValidatedAgeBand;
  });
  if (!ageBandCodes.has("ADULT") || !ageBandCodes.has("CHILD")) {
    throw new Error("VBK 拼小团年龄段必须同时包含 ADULT 和 CHILD。");
  }
  return validated;
}

export function groupUnitKey(ageBandId: unknown, tierId: unknown): string {
  return `${String(ageBandId)}::${String(tierId)}`;
}

export function assertGroupAgeBandConfig(ageBands: any[], maxGroupSize: number): void {
  const bands = validateGroupAgeBands(ageBands);
  for (const band of bands) {
    const incomplete = band.tiers.find((tier) => tier.tierCode === "INCOMPLETE_GROUP")!;
    const complete = band.tiers.find((tier) => tier.tierCode === "COMPLETED_GROUP")!;
    if (Number(incomplete.minPassengersRequired) !== 1
      || Number(incomplete.maxPassengersRequired) !== maxGroupSize - 1
      || Number(complete.minPassengersRequired) !== maxGroupSize
      || Number(complete.maxPassengersRequired) !== maxGroupSize) {
      throw new Error(`VBK 拼小团年龄段 ${band.ageBandCode} 成团区间回读不一致：期望 1-${maxGroupSize - 1}、${maxGroupSize}-${maxGroupSize}。`);
    }
  }
}

export function buildGroupPricingExpectation(
  ageBands: any[],
  pricing: any,
  dailyQuota: unknown,
): GroupPricingExpectation {
  const bands = validateGroupAgeBands(ageBands);
  const adultSalePrice = requirePositive(pricing?.adult, "成人销售价");
  const childSalePrice = requireFiniteNumber(pricing?.child, "儿童销售价");
  if (childSalePrice < 0) throw new Error("儿童销售价不得小于 0。");
  const adultCostPrice = effectiveCost(pricing?.cost?.adult, adultSalePrice, "成人成本价");
  const childCostPrice = effectiveCost(pricing?.cost?.child, childSalePrice, "儿童成本价");
  const quota = requirePositive(dailyQuota, "每日库存");
  const units: GroupUnitPriceExpectation[] = [];

  for (const band of bands) {
    for (const tier of band.tiers) {
      const baseCost = band.ageBandCode === "CHILD" ? childCostPrice : adultCostPrice;
      const baseSale = band.ageBandCode === "CHILD" ? childSalePrice : adultSalePrice;
      const costPrice = tier.tierCode === "COMPLETED_GROUP" ? Math.floor(baseCost * 0.97) : baseCost;
      const salePrice = tier.tierCode === "COMPLETED_GROUP" ? Math.floor(baseSale * 0.97) : baseSale;
      units.push({
        ageBandId: band.ageBandId,
        tierId: tier.tierId,
        ageBandCode: band.ageBandCode,
        tierCode: tier.tierCode,
        costPrice: requirePositive(costPrice, `${band.ageBandCode}/${tier.tierCode} 成本价`),
        salePrice: requirePositive(salePrice, `${band.ageBandCode}/${tier.tierCode} 销售价`),
      });
    }
  }
  return { adultCostPrice, adultSalePrice, childCostPrice, childSalePrice, dailyQuota: quota, units };
}

function rowDate(row: any): string {
  const unitDates = Array.isArray(row?.singleResourceUnitPriceDtos)
    ? row.singleResourceUnitPriceDtos.map((unit: any) => String(unit?.date ?? ""))
    : [];
  // GetBatchOperateSchedule 的实际返回把日期放在 base.productDate；
  // 测试/旧接口则可能仍在顶层。两种形态都必须识别，否则已写入的
  // 拼团班期会被聚合为 0 个匹配日期并被整年重复提交。
  const date = String(row?.productDate ?? row?.base?.productDate ?? unitDates[0] ?? "");
  return date && unitDates.every((unitDate: string) => unitDate === date) ? date : "";
}

function groupRowMatches(row: any, date: string, expected: GroupPricingExpectation): boolean {
  if (rowDate(row) !== date || Number(row?.inventory?.total) !== expected.dailyQuota) return false;
  const actualUnits = Array.isArray(row?.singleResourceUnitPriceDtos) ? row.singleResourceUnitPriceDtos : [];
  if (actualUnits.length !== expected.units.length) return false;
  // 拼小团在「分拆报价」模式下会把各人档的卖价标记为 Auto，并根据当前
  // 报价配置重新计算。此时请求中的 salePrice 是输入依据而非最终回读值；
  // 继续要求数值完全相等会把已成功写入的班期误判为失败，进而重复提交全年。
  // 仅当成人和儿童价格都明确由平台自动计算时放宽卖价数值，成本、库存、
  // 日期和年龄段/层级仍必须精确匹配。
  const salePriceAutoCalculated = [row?.adultPrice, row?.childPrice]
    .every((price) => price?.salePriceStatus === "Auto");
  const expectedByKey = new Map(expected.units.map((unit) => [groupUnitKey(unit.ageBandId, unit.tierId), unit]));
  const seen = new Set<string>();
  for (const actual of actualUnits) {
    const key = groupUnitKey(actual?.unitInfo?.ageBandId, actual?.unitInfo?.tierId);
    const unit = expectedByKey.get(key);
    const costPrice = Number(actual?.costPrice);
    const salePrice = Number(actual?.salePrice);
    if (!unit || seen.has(key)
      || !Number.isFinite(costPrice) || costPrice <= 0 || costPrice !== unit.costPrice
      || !Number.isFinite(salePrice) || salePrice <= 0
      || (!salePriceAutoCalculated && salePrice !== unit.salePrice)) return false;
    seen.add(key);
  }
  return seen.size === expectedByKey.size;
}

export function matchingGroupPricingDates(
  rows: any[],
  dates: string[],
  expected: GroupPricingExpectation,
): Set<string> {
  const expectedDates = new Set(dates);
  const rowsByDate = new Map<string, any[]>();
  for (const row of Array.isArray(rows) ? rows : []) {
    const date = rowDate(row);
    if (!expectedDates.has(date)) continue;
    rowsByDate.set(date, [...(rowsByDate.get(date) ?? []), row]);
  }
  return new Set(dates.filter((date) => {
    const dateRows = rowsByDate.get(date) ?? [];
    return dateRows.length === 1 && groupRowMatches(dateRows[0], date, expected);
  }));
}

export function assertGroupPricingReadback(
  rows: any[],
  dates: string[],
  expected: GroupPricingExpectation,
): void {
  const matched = matchingGroupPricingDates(rows, dates, expected);
  if (matched.size === dates.length) return;
  const mismatched = dates.filter((date) => !matched.has(date));
  throw new Error(`拼小团价格库存回读不一致：${matched.size}/${dates.length} 个日期精确匹配；异常日期：${mismatched.slice(0, 5).join("、")}`);
}
