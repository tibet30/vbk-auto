import type { TrafficLineVariant } from "../../../../shared/contracts-traffic-line.js";
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

export interface TrafficLineClauseRequirement {
  clauseItemId: number;
  secondClassTypeId: number;
  elementDtos: JsonRecord[];
}

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
      if (tabEnum === 1) assertTrafficResourceReady(central, variant);
      const clausePackage = await readClausePackage(page, central);
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
        buildTrafficLineClauseSaveRequest(central, desired),
        `保存子产品条款页签 ${tabEnum}`,
      );
      const clausePackageId = text(saved.clausePackageId) || text(central.clausePackageId);
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
  const context = trafficClauseContext(central);
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

export function mergeTrafficLineClauseItems(
  existing: readonly JsonRecord[],
  requirements: readonly TrafficLineClauseRequirement[],
): JsonRecord[] {
  const result = existing.map((item) => structuredClone(item));
  for (const requirement of requirements) {
    const replacement: JsonRecord = {
      clauseItemId: requirement.clauseItemId,
      secondClassTypeId: requirement.secondClassTypeId,
      elementDtos: structuredClone(requirement.elementDtos),
    };
    const index = result.findIndex((item) => Number(item.clauseItemId) === requirement.clauseItemId);
    if (index >= 0) result[index] = replacement;
    else result.push(replacement);
  }
  return result;
}

export function selectedClauseItems(clausePackage: JsonRecord): JsonRecord[] {
  const items: JsonRecord[] = [];
  for (const { type, item } of allClauseItems(clausePackage)) {
    if (item.selected === "T" || item.hasSelectBox === "F") {
      items.push({
        clauseItemId: item.clauseItemId,
        secondClassTypeId: type.clauseTypeId,
        elementDtos: list(item.clauseComponentDtos).map(clauseElementFromComponent),
      });
    }
  }
  return items.filter((item, index) => items.findIndex((candidate) =>
    Number(candidate.clauseItemId) === Number(item.clauseItemId)) === index);
}

function assertTrafficResourceReady(central: JsonRecord, variant: TrafficLineVariant): void {
  const resource = record(record(central.filterConditionDto)?.resourceConfigDto);
  const modeKey = variant === "flightRoundTrip" ? "isIncludeSystemFlight" : "isIncludeSystemTrain";
  if (resource?.[modeKey] !== "T" || resource.hasOutWardTraffic !== "T" || resource.hasReturnTraffic !== "T") {
    const label = variant === "flightRoundTrip" ? "飞机" : "火车";
    throw new Error(`子产品资源回读尚未生成${label}去返程条款，未保存条款，可安全重试。`);
  }
}

function uniqueChildTransport(
  items: readonly JsonRecord[],
  direction: "去程" | "返程",
  mode: "机票" | "火车票",
): TrafficLineClauseRequirement {
  const candidates = items.filter((item) => {
    const value = requirementText(item);
    return value.includes(direction) && value.includes(mode);
  });
  if (candidates.length !== 1) {
    throw new Error(`子产品${mode}条款无法唯一确认${direction}项（候选 ${candidates.length} 项），未保存。`);
  }
  return asRequirement(candidates[0]!);
}

function asRequirement(item: JsonRecord): TrafficLineClauseRequirement {
  return {
    clauseItemId: Number(item.clauseItemId),
    secondClassTypeId: Number(item.secondClassTypeId),
    elementDtos: structuredClone(list(item.elementDtos)),
  };
}

function requirementText(item: JsonRecord): string {
  return list(item.elementDtos).map((element) => text(element.value)).filter(Boolean).join(" ");
}

function verifyRequiredClauses(actual: readonly JsonRecord[], requirements: readonly JsonRecord[]): void {
  for (const requirement of requirements) {
    const requirementId = Number(requirement.clauseItemId);
    const item = actual.find((candidate) => Number(candidate.clauseItemId) === requirementId);
    if (!item) throw new Error(`子产品条款回读缺少条款 ${requirementId}。`);
    for (const expected of list(requirement.elementDtos)) {
      const exists = list(item.elementDtos).some((candidate) =>
        text(candidate.componentCode) === text(expected.componentCode) && text(candidate.value) === text(expected.value));
      if (!exists) throw new Error(`子产品条款 ${requirementId} 回读缺少组件 ${text(expected.componentCode)}。`);
    }
  }
}

export function clauseRequirementsByIds(
  clausePackage: JsonRecord,
  ids: readonly number[],
  tabEnum: number,
): TrafficLineClauseRequirement[] {
  return ids.map((id) => {
    const matches = allClauseItems(clausePackage).filter(({ item }) => Number(item.clauseItemId) === id);
    if (matches.length !== 1) {
      throw new Error(`子产品条款页签 ${tabEnum} 无法唯一确认平台必选条款 ${id}（候选 ${matches.length} 项）。`);
    }
    const { type, item } = matches[0]!;
    return {
      clauseItemId: id,
      secondClassTypeId: Number(type.clauseTypeId),
      elementDtos: list(item.clauseComponentDtos).map(clauseElementFromComponent),
    };
  });
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

function formatRequiredClauses(value: ReadonlyMap<number, readonly number[]>): string {
  return [...value].map(([tab, ids]) => `页签 ${tab}=${ids.join("、")}`).join("；");
}

export async function readClausePackage(page: TrafficLinePage, central: JsonRecord): Promise<JsonRecord> {
  const context = trafficClauseContext(central);
  const filter = context.filterConditionDto;
  delete context.filterConditionDto;
  return postTrafficLineRaw(page, "https://online.ctrip.com/restapi/soa2/20046/getClausePackage", {
    ...context,
    clauseFilterConditionDto: filter,
    firstClassClauseTypeIds: listOfIds(record(central.additionalInfoDto)?.firstClassTypeIds),
  }, "读取子产品条款包");
}

function trafficClauseContext(central: JsonRecord): JsonRecord {
  const additional = record(central.additionalInfoDto);
  const ids = additional?.firstClassTypeIds;
  if (!Array.isArray(ids)) throw new Error("子产品条款包缺少 firstClassTypeIds。");
  const filter = record(central.filterConditionDto);
  const rawProductId = filter?.productId;
  const productId = Number(text(rawProductId)) || rawProductId;
  return {
    ...central,
    requestBaseData: { locale: "zh-CN" },
    additionalInfoDto: { ...additional, isTra: "T", isChildrenToNew: "T" },
    businessData: encodeURIComponent(JSON.stringify({ productId, from: "vbk" })),
    head: TRAFFIC_LINE_HEAD,
  };
}

function listOfIds(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("子产品条款包缺少 firstClassTypeIds。");
  return [...value];
}

function allClauseItems(clausePackage: JsonRecord): Array<{ type: JsonRecord; item: JsonRecord }> {
  return list(clausePackage.clauseTypeDtos).flatMap((type) => [
    ...list(type.clauseItemDtos),
    ...list(type.containers).flatMap((container) => list(container.clauseItemDtos)),
  ].map((item) => ({ type, item })));
}

function clauseElementFromComponent(component: JsonRecord): JsonRecord {
  const selected = list(component.componentElementDtos)
    .find((candidate) => text(candidate.elementCode) === text(component.value));
  return selected ? {
    componentCode: component.componentCode,
    value: selected.elementValue,
    elementCode: selected.elementCode,
  } : {
    componentCode: component.componentCode,
    value: component.value,
  };
}
