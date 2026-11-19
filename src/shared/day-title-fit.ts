// 每日行程天标题的确定性裁剪：优先保住起点、住宿、含项与调用方指定的必含节点。
import {
  DAY_TITLE_MAX_NODES,
  itineraryTitleLength,
  parseDayTitle,
  renderDayTitle,
  type DayTitleFacts,
  type ParsedDayTitle,
} from "./day-title-grammar.js";

export function fitDayTitle(title: string, budget: number, keep: string[], _facts: DayTitleFacts = {}): string {
  const parsed = parseDayTitle(title);
  const kept = new Set(keep.map((name) => name.trim()).filter(Boolean));
  let current: ParsedDayTitle = { ...parsed, nodes: [...parsed.nodes] };
  while (current.nodes.length > DAY_TITLE_MAX_NODES) {
    const index = removableIndex(current.nodes, kept);
    if (index < 0) break;
    current.nodes = current.nodes.filter((_, position) => position !== index);
  }
  if (tooLong(current, budget) && current.includes) current = { ...current, includes: "" };
  if (tooLong(current, budget) && current.stay) current = { ...current, stay: "" };
  while (tooLong(current, budget) && current.nodes.length) {
    const index = removableIndex(current.nodes, kept);
    if (index < 0) break;
    current.nodes = current.nodes.filter((_, position) => position !== index);
  }
  if (tooLong(current, budget)) {
    current = { ...current, nodes: current.nodes.filter((node) => kept.has(node.name)) };
  }
  return renderDayTitle(current);
}

function tooLong(parsed: ParsedDayTitle, budget: number): boolean {
  return itineraryTitleLength(renderDayTitle(parsed)) > budget;
}

function removableIndex(nodes: ParsedDayTitle["nodes"], kept: Set<string>): number {
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    if (!kept.has(nodes[index]!.name)) return index;
  }
  return -1;
}
