import { list, record, text, type JsonRecord } from "./client.js";

export interface TrafficLineClauseRequirement {
  clauseItemId: number;
  secondClassTypeId: number;
  elementDtos: JsonRecord[];
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

export function allClauseItems(clausePackage: JsonRecord): Array<{ type: JsonRecord; item: JsonRecord }> {
  return list(clausePackage.clauseTypeDtos).flatMap((type) => [
    ...list(type.clauseItemDtos),
    ...list(type.containers).flatMap((container) => {
      const selectedId = text(container.selectedClauseItemId);
      return list(container.clauseItemDtos).map((item) => selectedId ? {
        ...item,
        // 交通条款与普通条款使用同一套容器协议：单选容器把选中 ID
        // 放在 container 上，item.selected 可能为空或仍为 F。若忽略这层
        // 状态，已由平台生成的去返程条款会被误判成候选 0 项。
        selected: text(item.clauseItemId) === selectedId ? "T" : "F",
      } : item);
    }),
  ].map((item) => ({ type, item })));
}

export function clauseElementFromComponent(component: JsonRecord): JsonRecord {
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

export function uniqueChildTransport(
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

export function asRequirement(item: JsonRecord): TrafficLineClauseRequirement {
  return {
    clauseItemId: Number(item.clauseItemId),
    secondClassTypeId: Number(item.secondClassTypeId),
    elementDtos: structuredClone(list(item.elementDtos)),
  };
}

export function requirementText(item: JsonRecord): string {
  return list(item.elementDtos).map((element) => text(element.value)).filter(Boolean).join(" ");
}

export function verifyRequiredClauses(actual: readonly JsonRecord[], requirements: readonly JsonRecord[]): void {
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

export function formatRequiredClauses(value: ReadonlyMap<number, readonly number[]>): string {
  return [...value].map(([tab, ids]) => `页签 ${tab}=${ids.join("、")}`).join("；");
}

export function listOfIds(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("子产品条款包缺少 firstClassTypeIds。");
  return [...value];
}

export function trafficClauseContext(central: JsonRecord, head: JsonRecord): JsonRecord {
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
    head,
  };
}
