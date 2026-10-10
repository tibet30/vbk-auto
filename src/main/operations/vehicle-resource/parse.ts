/**
 * VBK 资源库 payload → 候选解析：
 *   - extractResourceGroups：递归遍历 payload，找到所有同时含 resourceGroupId +
 *     resourceGroupName 的对象；用 seen WeakSet 防环。
 *   - firstResourceGroup：取第一个候选；
 *   - bestResourceGroup：按目标总价 ±20% 容差，挑价格最贴近的；
 *   - parseResourceGroup：单记录 → ResolvedVehicleResource 解析；
 *   - parseVehicleResourceGroupNamePrice：从资源组名称中临时解析车型价格，仅用于
 *     选择最接近全程总价，不写回 product JSON。
 *
 * 容差排序规则：
 *   - 解析出价格后按距离排序；
 *   - 没有任何候选解析出价格时，退回"第一条候选"，避免"知道有车但不选"。
 */

import { escapeRegExp, firstNumber, firstText, normalisedText, positiveNumber } from "./helpers.js";
import type { ResolvedVehicleResource } from "./types.js";

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

export function firstResourceGroup(payload: unknown) {
  const groups = extractResourceGroups(payload);
  if (!groups.length) return undefined;
  const [record] = groups;
  return parseResourceGroup(record);
}

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

function parseResourceGroup(record: Record<string, unknown>) {
  const resourceGroupId = firstNumber(record, ["resourceGroupId", "resourceGroupID", "groupId", "id"]);
  const resourceGroupName = firstText(record, ["resourceGroupName", "groupName", "name"]);
  if (!resourceGroupId || !resourceGroupName) return undefined;
  return {
    resourceGroupId,
    resourceGroupName,
  } satisfies Pick<ResolvedVehicleResource, "resourceGroupId" | "resourceGroupName">;
}