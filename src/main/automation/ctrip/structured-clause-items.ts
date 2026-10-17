type ClauseRecord = Record<string, any>;

interface ClauseElement {
  componentCode?: unknown;
  elementCode?: unknown;
  elementValue?: unknown;
  value?: unknown;
}

export interface SelectedClauseItem {
  clauseItemId: number;
  secondClassTypeId: number;
  elementDtos: ClauseElement[];
}

function clauseElements(item: ClauseRecord): ClauseElement[] {
  return (item.clauseComponentDtos ?? []).map((component: ClauseRecord) => {
    const element = component.componentElementDtos?.find(
      (candidate: ClauseRecord) => candidate.elementCode === component.value,
    );
    return {
      componentCode: component.componentCode,
      value: element?.elementValue ?? component.value,
      ...(element ? { elementCode: element.elementCode } : {}),
    };
  });
}

export function formatSelectedClauseItems(clauseTypeDtos: ClauseRecord[] = []): SelectedClauseItem[] {
  const result: SelectedClauseItem[] = [];
  for (const type of clauseTypeDtos ?? []) {
    const selectedItems = [
      ...(type.clauseItemDtos ?? []),
      ...(type.containers ?? []).flatMap((container: ClauseRecord) =>
        (container.clauseItemDtos ?? []).map((item: ClauseRecord) => ({
          ...item,
          selected: container.selectedClauseItemId == null
            ? item.selected
            : String(item.clauseItemId) === String(container.selectedClauseItemId) ? "T" : "F",
        })),
      ),
    ].filter((item: ClauseRecord) => {
      if (item.itemType != null && item.itemType !== "F") return false;
      if (item.isShow != null && item.isShow !== "T") return false;
      if (item.hasSelectBox === "F") return true;
      return item.selected === "T";
    });
    for (const item of selectedItems) {
      result.push({
        clauseItemId: item.clauseItemId,
        secondClassTypeId: type.clauseTypeId,
        elementDtos: clauseElements(item),
      });
    }
  }
  return result;
}

export function ensureRequiredClause(
  items: SelectedClauseItem[],
  clauseTypeDtos: ClauseRecord[] = [],
  clauseItemId: number,
): SelectedClauseItem[] {
  if (items.some((item) => item.clauseItemId === clauseItemId)) return items;
  for (const type of clauseTypeDtos ?? []) {
    const candidates = [
      ...(type.clauseItemDtos ?? []),
      ...(type.containers ?? []).flatMap((container: ClauseRecord) => container.clauseItemDtos ?? []),
    ];
    const target = candidates.find((item: ClauseRecord) => item.clauseItemId === clauseItemId);
    if (!target) continue;
    return [...items, {
      clauseItemId: target.clauseItemId,
      secondClassTypeId: type.clauseTypeId,
      elementDtos: clauseElements(target),
    }];
  }
  throw new Error(`VBK 条款包缺少必选条款 ${clauseItemId}`);
}

export function setClauseComponentValue(
  items: SelectedClauseItem[],
  clauseItemId: number,
  componentCode: string,
  value: unknown,
): SelectedClauseItem[] {
  let found = false;
  const next = items.map((item) => {
    if (item.clauseItemId !== clauseItemId) return item;
    const elements = (item.elementDtos ?? []).map((element) => {
      if (element.componentCode !== componentCode) return element;
      found = true;
      return { ...element, value };
    });
    return { ...item, elementDtos: elements };
  });
  if (!found) throw new Error(`VBK 条款 ${clauseItemId} 缺少组件 ${componentCode}`);
  return next;
}
