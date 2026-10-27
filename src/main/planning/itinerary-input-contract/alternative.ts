/**
 * itinerary-input-contract 二选一（OR group）相关：
 *   - rawAlternativeGroups：从 basicInfo.userIdea 文本里解析"第 N 天：A 或 B"形式的
 *     二选一景点（中文 / 阿拉伯数字 day token 都支持）；
 *   - cleanAlternativeName：去 Markdown 强调/标题标记（**、_、`、#）+ 去前缀
 *     （去 / 游览 / 参观 / 安排）+ 去括号注释；
 *   - uniqueGroups：按 day:names 串去重；
 *   - explicitAlternativeGroups：合并 userIntent.activities 与 userIdea 文本；
 *   - explicitAlternativeGroupError：调用方校验必须保证：
 *       (i) 全部选项都在 day.spots 里；
 *       (ii) 每个选项都必须保留为景点类型（不能自由活动 / other 隐藏）；
 *       (iii) 多选项时 relation = "or"，单选项时 relation = "and"；
 *       (iv) 必须位于同一时段（timeOfDay 一致）；
 *       (v) 在 spots 里必须连续相邻。
 *   - hasTrustedOperatorAlternativeDeletion：检查 trusted manual-review IPC 是否授权
 *     指定 day + name 的非 OR 组成员可被删除（按 group key 唯一授权）。
 */

import type { ProductDetail } from "../../../shared/contracts.js";
import { supportArrangementType } from "../../../shared/itinerary-support-arrangements.js";
import { alternativeGroupKey, hasTrustedOperatorItineraryRemoval } from "../../../shared/trusted-operator-itinerary-removals.js";
import { requiresItineraryPoi } from "../../../shared/itinerary-activity-kind.js";
import { asDayList, asRecord, isDeletableAdministrativeLocation, requiresLockedAttraction, samePlace, spotName, text, unique } from "./utils.js";
import { daySections } from "../day-sections.js";
import { constraintUserIdea } from "../../../shared/product-idea-optimization.js";

export function explicitAlternativeGroups(product: ProductDetail): Array<{ day: number; names: string[] }> {
  const structured = (product.planning?.userIntent?.activities ?? []).flatMap((activity) => {
    const names = unique([activity.title, ...(activity.alternatives ?? [])]);
    return activity.kind === "poi" && activity.day > 0 && names.length > 1 ? [{ day: activity.day, names }] : [];
  });
  const raw = constraintUserIdea(product.product.basicInfo);
  // 原始文本里「住A或者B」是住宿城市二选一，不是景点 OR 组；只要组里出现
  // 非景点选项（住宿/接送/行政地点），整组不锁定，否则会要求为不存在的 POI
  // 同时绑定两个“景点”，规划永远无法通过。
  const parsed = rawAlternativeGroups(raw)
    .filter((group) => group.names.every((name) => isPoiAlternativeOption(product, name)));
  return uniqueGroups([...structured, ...parsed]);
}

function isPoiAlternativeOption(product: ProductDetail, name: string): boolean {
  const value = name.trim();
  return Boolean(value)
    && requiresLockedAttraction(value)
    && !isDeletableAdministrativeLocation(product, value)
    && supportArrangementType({ name: value }) === undefined;
}

export function rawAlternativeGroups(value: string): Array<{ day: number; names: string[] }> {
  // 与逐日顺序共用 day-sections 的分段：最后一天在行首【补充建议】等分节标题处截断，
  // 否则文末的建议段会被当成最后一天的景点二选一。
  return daySections(value).flatMap(({ day, body }) => {
    // Operational sentences after a day's route are not scenic alternatives.
    return body.split(/[-—–→。；;\n，,]+/u).flatMap((segment) => {
      // 接送方式的"或"属于服务选择，不能锁成必须同时保留的景点 OR 组。
      if (supportArrangementType({ name: segment.trim() }) === "transport") return [];
      if (/^\s*(?:不含|不包含|不安排|不提交|不发布|不需要|无需|不要)/u.test(segment)) return [];
      if (/^\s*(?:第\s*[0-9一二三四五六七八九十]+\s*晚|(?:参考)?酒店|住宿|入住)/u.test(segment)) return [];
      // 「住巫山或者万州」是当晚住宿城市二选一，不是景点 OR 组。住宿不是
      // 可绑定 POI 的游览站点，锁成二选一景点会让行程生成永远无法通过。
      if (/^\s*(?:住|宿(?!州|迁|松))/u.test(segment)) return [];
      if (!/(?:或者|或)/u.test(segment)
        && !(/(?:二选一|多选一|任选其一)/u.test(segment) && /(?:\/|／)/u.test(segment))) return [];
      const names = unique(segment
        .replace(/【[^】]*】|\[[^\]]*\]|\([^)]*\)|（[^）]*）/gu, "")
        .replace(/(?:二选一|多选一|任选其一)/gu, "")
        .split(/\s*(?:或者|或|\/|／)\s*/u)
        .map(cleanAlternativeName));
      return names.length > 1 ? [{ day, names }] : [];
    });
  });
}

export function cleanAlternativeName(value: string): string {
  return value
    // 用户想法常用 Markdown 强调/标题标记包裹景点名（“** 日喀则博物馆”）。
    // 标记留在组名里会让组身份与行程 spot 名不一致，运营删除二选一项后
    // 凭证永远匹配不上，行程校验继续要求保留该项。
    .replace(/[*_`~#]+/gu, " ")
    .replace(/^[:：、，,\s]+/u, "")
    // 住宿前缀不是景点名的一部分：「或者住巫山」→「巫山」。
    .replace(/^(?:入住|住宿|宿(?!州|迁|松)|住)\s*/u, "")
    .replace(/^(?:去|游览|参观|安排)\s*/u, "")
    .trim();
}

export function uniqueGroups(groups: Array<{ day: number; names: string[] }>): Array<{ day: number; names: string[] }> {
  const seen = new Set<string>();
  return groups.filter((group) => {
    const key = `${group.day}:${group.names.map((name) => name.replace(/\s+/g, "")).join("|")}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * 二选一不是在规划期挑出一个默认项：所有原始选项都要保留在同一天的同一段，
 * 再由 VBK 的 orFlag 表达"任选其一"。这层也覆盖对话式 patch 路径，避免
 * 只走三阶段 planner 时才生效。
 */
export function explicitAlternativeGroupError(
  product: ProductDetail,
  itinerary: Record<string, unknown>[],
): string | undefined {
  const groups = explicitAlternativeGroups(product);
  if (!groups.length) return undefined;
  const days = new Map(itinerary.map((day) => [Number(day.day), day]));
  for (const group of groups) {
    const day = days.get(group.day);
    const spots = Array.isArray(day?.spots) ? day.spots.filter(asRecord) : [];
    const names = group.names.filter((name) => !hasTrustedOperatorAlternativeDeletion(product, group.day, name, group));
    const matches = names.map((name) => ({ name, index: spots.findIndex((spot) => samePlace(spotName(spot), name)) }));
    const missing = matches.filter((match) => match.index < 0).map((match) => match.name);
    if (missing.length) return `第 ${group.day} 天的二选一景点必须全部保留：${missing.join("、")}`;
    const selected = matches.map((match) => spots[match.index]!);
    if (!selected.every(requiresItineraryPoi)) {
      return `第 ${group.day} 天的二选一景点必须保留为景点类型，不能用自由活动或其他活动隐藏。`;
    }
    if (!selected.every((spot) => spot.relation === (names.length === 1 ? "and" : "or"))) {
      return `第 ${group.day} 天的二选一景点「${group.names.join("或")}」必须都标记为 relation: "or"。`;
    }
    const times = new Set(selected.map((spot) => spot.timeOfDay).filter((time): time is string => time === "morning" || time === "afternoon"));
    if (times.size !== 1) return `第 ${group.day} 天的二选一景点「${group.names.join("或")}」必须位于同一时段。`;
    const indexes = matches.map((match) => match.index).sort((left, right) => left - right);
    if (indexes.some((index, position) => position > 0 && index !== indexes[position - 1]! + 1)) {
      return `第 ${group.day} 天的二选一景点「${group.names.join("或")}」必须连续放在同一段行程。`;
    }
  }
  return undefined;
}

/** Only the trusted manual-review IPC may authorize a named original POI to disappear. */
export function hasTrustedOperatorAlternativeDeletion(
  product: ProductDetail, day: number, name: string, group?: { day: number; names: readonly string[] },
): boolean {
  const groups = explicitAlternativeGroups(product).filter((candidate) => candidate.day === day && candidate.names.some((item) => samePlace(item, name)));
  const target = group ?? (groups.length === 1 ? groups[0] : undefined);
  if (target) {
    const ambiguous = groups.length > 1;
    return hasTrustedOperatorItineraryRemoval(product.product, day, name, alternativeGroupKey(day, target.names), ambiguous);
  }
  if (groups.length > 1) {
    // A shared spelling can occur in separate OR groups. A receipt for one
    // group cannot authorize the other; only one receipt per group can.
    return groups.every((candidate) => hasTrustedOperatorItineraryRemoval(
      product.product, day, name, alternativeGroupKey(day, candidate.names), true,
    ));
  }
  // A legacy day/name receipt has no positional evidence. Do not let it exempt
  // duplicate same-day OR members; an operator must delete the exact slot again.
  return groups.length === 0 && hasTrustedOperatorItineraryRemoval(product.product, day, name);
}

export function hasTrustedOperatorAlternativeDeletionOnAnyDay(product: ProductDetail, name: string): boolean {
  return (asDayList(product.product.itinerary) ?? []).some((day) =>
    hasTrustedOperatorAlternativeDeletion(product, Number(day.day), name));
}
