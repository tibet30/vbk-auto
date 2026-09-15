import type { TrafficLineVariant } from "../../../../shared/contracts-traffic-line.js";
import {
  allClauseItems,
  asRequirement,
  clauseElementFromComponent,
  clauseRequirementsByIds,
  formatRequiredClauses,
  listOfIds,
  mergeTrafficLineClauseItems,
  requirementText,
  selectedClauseItems,
  trafficClauseContext,
  uniqueChildTransport,
  verifyRequiredClauses,
  type TrafficLineClauseRequirement,
} from "./clause-items.js";
import { readManualRequiredClauses } from "./clause-required.js";
import {
  TRAFFIC_LINE_HEAD,
  list,
  postTrafficLineRaw,
  postTrafficLineSoa,
  record,
  text,
  type JsonRecord,
  type TrafficLinePage,
} from "./client.js";

export type { TrafficLineClauseRequirement } from "./clause-items.js";
export {
  clauseRequirementsByIds,
  mergeTrafficLineClauseItems,
  selectedClauseItems,
} from "./clause-items.js";

/**
 * 交通子产品使用平台 isTra=T 的实时子产品 schema。资源提交成功后，平台会
 * 自动生成去程、返程的 38725/38739 类条款；普通母产品的 3035/10081 不在
 * 此 schema 中，强塞会被服务端静默丢弃，不能作为成功条件。
 */
export async function ensureTrafficLineClauses(
  page: TrafficLinePage,
  productId: string,
  variant: TrafficLineVariant,
): Promise<{ tabs: number; itemCount: number }> {
  let requiredByTab = await readManualRequiredClauses(page, productId);
  for (let round = 1; round <= 2; round += 1) {
    let itemCount = 0;
    const expectedFormalIds = new Set<number>();
    // 费用页会触发跨页必选条款计算，先落 tab 2，再保存其它页签。
    // 第二轮仅修平台明确指出的页签，避免已有效产品无差别重写其它包。
    const tabs = round === 1
      ? [2, 1, 3, 4]
      : [2, 1, 3, 4].filter((tabEnum) => requiredByTab.has(tabEnum));
    for (const tabEnum of tabs) {
      const productClause = await postTrafficLineSoa(
        page, "15638", "listProductClauses", { productId, tabEnum }, `读取子产品条款页签 ${tabEnum}`,
      );
      const central = record(productClause.centralDataDto);
      if (!central) throw new Error(`子产品条款页签 ${tabEnum} 缺少 centralDataDto。`);
      const ready = tabEnum === 1
        ? await waitForTrafficLineFirstTabReadiness(
          async () => {
            const latest = await postTrafficLineSoa(
              page, "15638", "listProductClauses", { productId, tabEnum }, `重读子产品条款页签 ${tabEnum}`,
            );
            const latestCentral = record(latest.centralDataDto);
            if (!latestCentral) throw new Error(`子产品条款页签 ${tabEnum} 缺少 centralDataDto。`);
            return latestCentral;
          },
          (latestCentral) => readClausePackage(page, latestCentral),
          variant,
        )
        : { central, clausePackage: await readClausePackage(page, central) };
      const readyCentral = ready.central;
      const clausePackage = ready.clausePackage;
      const existing = selectedClauseItems(clausePackage);
      let desired = tabEnum === 1
        ? desiredFirstTabClauses(clausePackage, existing, variant)
        : existing;
      desired = mergeTrafficLineClauseItems(
        desired,
        clauseRequirementsByIds(clausePackage, requiredByTab.get(tabEnum) ?? [], tabEnum),
      );
      const saved = await postTrafficLineRaw(
        page,
        "https://online.ctrip.com/restapi/soa2/20046/saveClausePackage",
        buildTrafficLineClauseSaveRequest(readyCentral, desired),
        `保存子产品条款页签 ${tabEnum}`,
      );
      const clausePackageId = text(saved.clausePackageId) || text(readyCentral.clausePackageId);
      if (!clausePackageId) throw new Error(`保存子产品条款页签 ${tabEnum} 后缺少 clausePackageId。`);
      // 与当前 VBK 条款页一致：条款草稿由 20698 创建，再把刚保存的包绑定。
      await postTrafficLineSoa(page, "20698", "createProductDraft", {
        productId: Number(productId) || productId,
        module: "clause",
      }, `创建子产品条款草稿 ${tabEnum}`);
      await postTrafficLineSoa(
        page,
        "15638",
        "saveProductClauses.json",
        buildSaveProductClausesRequest(productId, clausePackageId, tabEnum),
        `绑定子产品条款页签 ${tabEnum}`,
      );
      const rebound = await postTrafficLineSoa(
        page, "15638", "listProductClauses", { productId, tabEnum }, `回读子产品条款页签 ${tabEnum}`,
      );
      const reboundCentral = record(rebound.centralDataDto);
      if (!reboundCentral) throw new Error(`子产品条款页签 ${tabEnum} 保存后缺少 centralDataDto。`);
      if (text(reboundCentral.clausePackageId) !== clausePackageId) {
        throw new Error(`子产品条款页签 ${tabEnum} 未绑定刚保存的条款包。`);
      }
      const readback = await readClausePackage(page, reboundCentral);
      const actual = selectedClauseItems(readback);
      verifyRequiredClauses(actual, desired);
      if (tabEnum === 1) {
        assertTrafficResourceReady(reboundCentral, variant);
        resolveChildTransportClauseRequirements(readback, variant);
      }
      desired.forEach((item) => expectedFormalIds.add(Number(item.clauseItemId)));
      itemCount += actual.length;
    }
    let remaining = await readManualRequiredClauses(page, productId);
    if (!remaining.size) {
      await verifyFormalClauseIds(page, productId, expectedFormalIds);
      // getProductClause 可能在正式包回读时才触发下一批平台必选项计算。
      // 正式回读后必须再做一轮 get -> autoSave 探针，不能把晚出现的
      // tab4 必选条款误判成已收敛。
      remaining = await readManualRequiredClauses(page, productId);
      if (!remaining.size) return { tabs: 4, itemCount };
    }
    if (round === 2) {
      throw new Error(`子产品必选条款两轮保存后仍未收敛：${formatRequiredClauses(remaining)}。`);
    }
    requiredByTab = remaining;
  }
  throw new Error("子产品条款保存未完成。");
}

/**
 * 资源校验成功与 20046 条款 schema 物化不是同一个事务。只在平台尚未生成
 * 必需条款（0 项）时做短暂只读重读；重复候选或其它协议错误立即失败，避免
 * 用等待掩盖真实歧义，更不能在条款出现前提交一个不完整的包。
 */
export async function waitForTrafficLineClausePackage(
  read: () => Promise<JsonRecord>,
  variant: TrafficLineVariant,
  options: { maxReads?: number; intervalMs?: number; sleep?: (milliseconds: number) => Promise<void> } = {},
): Promise<JsonRecord> {
  const maxReads = Math.max(1, options.maxReads ?? 8);
  const intervalMs = Math.max(0, options.intervalMs ?? 1_500);
  const sleep = options.sleep ?? ((milliseconds: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxReads; attempt += 1) {
    const clausePackage = await read();
    try {
      desiredFirstTabClauses(clausePackage, selectedClauseItems(clausePackage), variant);
      return clausePackage;
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (!/无法唯一确认(?:去程项|返程项|儿童票说明|接送机条款)（候选 0 项）/.test(message)
        || attempt === maxReads) throw error;
      await sleep(intervalMs);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("子产品条款尚未生成。");
}

/**
 * 交通资源提交完成后，15638 的资源标记和 20046 的条款包会分别异步物化。
 * 两者都只做只读等待；任一项未生成时都不能提前保存条款包。
 */
export async function waitForTrafficLineFirstTabReadiness(
  readCentral: () => Promise<JsonRecord>,
  readClausePackage: (central: JsonRecord) => Promise<JsonRecord>,
  variant: TrafficLineVariant,
  options: { maxReads?: number; intervalMs?: number; sleep?: (milliseconds: number) => Promise<void> } = {},
): Promise<{ central: JsonRecord; clausePackage: JsonRecord }> {
  const maxReads = Math.max(1, options.maxReads ?? 20);
  const intervalMs = Math.max(0, options.intervalMs ?? 1_500);
  const sleep = options.sleep ?? ((milliseconds: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxReads; attempt += 1) {
    const central = await readCentral();
    try {
      assertTrafficResourceReady(central, variant);
      const clausePackage = await readClausePackage(central);
      desiredFirstTabClauses(clausePackage, selectedClauseItems(clausePackage), variant);
      return { central, clausePackage };
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (!isPendingTrafficLineFirstTabReadiness(message) || attempt === maxReads) throw error;
      await sleep(intervalMs);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("子产品条款页签 1 尚未生成交通资源条款。");
}

function isPendingTrafficLineFirstTabReadiness(message: string): boolean {
  return /资源回读尚未生成(?:飞机|火车)去返程条款/.test(message)
    || /无法唯一确认(?:去程项|返程项|儿童票说明|接送机条款)（候选 0 项）/.test(message);
}

export function buildSaveProductClausesRequest(productId: string, packageId: string, tabEnum: number): JsonRecord {
  return {
    packageId: Number(packageId),
    saveType: 3,
    productId,
    tabEnum,
    clauseEditDtos: [],
    unBookingRuleDtos: [],
  };
}

/** 精确复刻当前 VBK 交通子产品条款页的 saveClausePackage 上下文。 */
export function buildTrafficLineClauseSaveRequest(
  central: JsonRecord,
  clausePackageItemDtos: readonly JsonRecord[],
): JsonRecord {
  const context = trafficClauseContext(central, TRAFFIC_LINE_HEAD);
  const filter = record(central.filterConditionDto);
  return {
    ...context,
    firstClassClauseTypeIds: listOfIds(record(central.additionalInfoDto)?.firstClassTypeIds),
    clausePackageItemDtos: structuredClone(clausePackageItemDtos),
    pICategoryId: filter?.pICategoryId,
  };
}

export function desiredFirstTabClauses(
  clausePackage: JsonRecord,
  existing: readonly JsonRecord[],
  variant: TrafficLineVariant,
): JsonRecord[] {
  const requiredTransport = resolveChildTransportClauseRequirements(clausePackage, variant);
  const legacyMainTransportIds = new Set([3035, 10081, 4]);
  let desired = mergeTrafficLineClauseItems(
    existing
      .filter((item) => Number(item.secondClassTypeId) !== 316)
      .filter((item) => !legacyMainTransportIds.has(Number(item.clauseItemId))),
    requiredTransport,
  );
  const transferItems = allClauseItems(clausePackage)
    .filter(({ type }) => Number(type.clauseTypeId) === 316 || text(type.clauseTypeName) === "接送");
  if (transferItems.length !== 1) {
    throw new Error(`子产品条款无法唯一确认接送机条款（候选 ${transferItems.length} 项）。`);
  }
  const { type, item } = transferItems[0]!;
  desired = mergeTrafficLineClauseItems(desired, [{
    clauseItemId: Number(item.clauseItemId),
    secondClassTypeId: Number(type.clauseTypeId),
    elementDtos: list(item.clauseComponentDtos).map(clauseElementFromComponent),
  }]);
  return desired;
}

/**
 * 从子产品自己的实时包中确认平台自动生成的去程、返程大交通条款。只按方向与
 * 交通方式语义匹配，避免把母产品的普通主交通条款误当成子产品必选项。
 */
export function resolveChildTransportClauseRequirements(
  clausePackage: JsonRecord,
  variant: TrafficLineVariant,
): TrafficLineClauseRequirement[] {
  const mode = variant === "flightRoundTrip" ? "机票" : "火车票";
  const traffic = selectedClauseItems(clausePackage)
    .filter((item) => Number(item.secondClassTypeId) === 86);
  const outbound = uniqueChildTransport(traffic, "去程", mode);
  const returning = uniqueChildTransport(traffic, "返程", mode);
  if (outbound.clauseItemId === returning.clauseItemId) {
    throw new Error(`子产品${mode}条款未分别生成去程与返程条款，未保存。`);
  }
  const result = [outbound, returning];
  if (variant === "trainRoundTrip") {
    const children = traffic.filter((item) => {
      const value = requirementText(item);
      return value.includes("儿童") && value.includes("火车票");
    });
    if (children.length !== 1) {
      throw new Error(`子产品火车票条款无法唯一确认儿童票说明（候选 ${children.length} 项），未保存。`);
    }
    result.push(asRequirement(children[0]!));
  }
  return result;
}

function assertTrafficResourceReady(central: JsonRecord, variant: TrafficLineVariant): void {
  const resource = record(record(central.filterConditionDto)?.resourceConfigDto);
  const modeKey = variant === "flightRoundTrip" ? "isIncludeSystemFlight" : "isIncludeSystemTrain";
  if (resource?.[modeKey] !== "T" || resource.hasOutWardTraffic !== "T" || resource.hasReturnTraffic !== "T") {
    const label = variant === "flightRoundTrip" ? "飞机" : "火车";
    throw new Error(`子产品资源回读尚未生成${label}去返程条款，未保存条款，可安全重试。`);
  }
}

async function verifyFormalClauseIds(
  page: TrafficLinePage,
  productId: string,
  expected: ReadonlySet<number>,
): Promise<void> {
  const payload = await postTrafficLineSoa(page, "20698", "getProductClause", {
    productId,
    onlyNeedId: true,
    needDraft: false,
    needMatched: false,
  }, "回读子产品正式条款");
  const actual = new Set(list(payload.formalDtos).map((item) => Number(item.clauseItemId)));
  const missing = [...expected].filter((id) => !actual.has(id));
  if (missing.length) throw new Error(`子产品正式条款回读缺少：${missing.join("、")}。`);
}

export async function readClausePackage(page: TrafficLinePage, central: JsonRecord): Promise<JsonRecord> {
  const context = trafficClauseContext(central, TRAFFIC_LINE_HEAD);
  const filter = context.filterConditionDto;
  delete context.filterConditionDto;
  return postTrafficLineRaw(page, "https://online.ctrip.com/restapi/soa2/20046/getClausePackage", {
    ...context,
    clauseFilterConditionDto: filter,
    firstClassClauseTypeIds: listOfIds(record(central.additionalInfoDto)?.firstClassTypeIds),
  }, "读取子产品条款包");
}
