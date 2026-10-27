import type { ProductDetail } from "../../shared/contracts.js";
import type { LockedItineraryDay } from "../../shared/contracts-preparation.js";
import { extractLockedConstraints } from "../agent/prompt-helpers.js";
import { explicitAlternativeGroups } from "./itinerary-input-contract/alternative.js";

/**
 * 优化稿只能整理表达，不能改动逐日硬约束。规划按原文解析硬约束、把优化稿
 * 作为提示，两者一致时才不会出现「必须保留」与「不能新增」互相矛盾。
 * 返回差异说明；undefined 表示原文已锁定的每一天，景点、顺序和二选一都一致。
 */
export function ideaConstraintDifference(originalIdea: string, optimizedIdea: string, days: number): string | undefined {
  const original = parsed(originalIdea, days);
  const optimized = parsed(optimizedIdea, days);
  const differences: string[] = [];
  // 只核对原文已锁定的日子：原文未写的日子，优化稿补出的安排只是规划提示。
  for (const day of [...original.order.keys()].filter((value) => value >= 1 && value <= days)) {
    const before = original.order.get(day);
    const after = optimized.order.get(day);
    if (!sameSpots(before?.spots ?? [], after?.spots ?? [])
      || !sameSpots(before?.unorderedSpots ?? [], after?.unorderedSpots ?? [])) {
      differences.push(`第${day}天景点由「${label(before)}」变为「${label(after)}」`);
    }
  }
  for (const group of optimized.alternatives.filter((item) => original.order.has(item.day))) {
    if (!original.alternatives.some((item) => item.day === group.day && sameSpots(item.names, group.names))) {
      differences.push(`第${group.day}天新增二选一「${group.names.join("或")}」`);
    }
  }
  return differences.length ? differences.join("；") : undefined;
}

function parsed(userIdea: string, days: number) {
  const detail = { id: "idea", name: "", status: "planning", updatedAt: "", messages: [], researchTasks: [],
    product: { basicInfo: { userIdea, days } } } as unknown as ProductDetail;
  const order = new Map(extractLockedConstraints(detail, []).itineraryOrder.map((row) => [row.day, row]));
  return { order, alternatives: explicitAlternativeGroups(detail) };
}

function compact(value: string): string {
  return value.replace(/[\s。，,；;]+/gu, "");
}

function sameSpots(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((name, index) => compact(name) === compact(right[index]!));
}

function label(row: LockedItineraryDay | undefined): string {
  return [...(row?.spots ?? []), ...(row?.unorderedSpots ?? [])].join("、") || "无";
}
