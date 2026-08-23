/**
 * 产品级 AI usage 事件合并与聚合。
 * Token 与 estimatedCostCny 均可由事件本地合计；
 * 仅当事件侧算不出费用时，才保留既有 lifetime / latestRun 上的 Tibet 回写值。
 */

import {
  AI_USAGE_EVENT_CAP,
  type AiUsageEvent,
  type AiUsageTotals,
  type ProductAiUsage,
} from "../../shared/contracts-ai-usage.js";

function emptyTotals(): AiUsageTotals {
  return {
    calls: 0,
    durationMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    tokensIncomplete: false,
    estimatedCostCny: null,
  };
}

function sumTokens(events: readonly AiUsageEvent[]): AiUsageTotals {
  const totals = emptyTotals();
  totals.calls = events.length;
  let incomplete = false;
  let input = 0;
  let output = 0;
  let total = 0;
  let cost: number | null = null;

  for (const event of events) {
    totals.durationMs += Math.max(0, event.durationMs || 0);
    if (event.inputTokens === null || event.outputTokens === null || event.totalTokens === null) {
      incomplete = true;
    } else {
      input += event.inputTokens;
      output += event.outputTokens;
      total += event.totalTokens;
    }
    if (typeof event.estimatedCostCny === "number" && Number.isFinite(event.estimatedCostCny)) {
      cost = (cost ?? 0) + event.estimatedCostCny;
    }
  }

  if (incomplete) {
    totals.inputTokens = null;
    totals.outputTokens = null;
    totals.totalTokens = null;
    totals.tokensIncomplete = true;
  } else {
    totals.inputTokens = input;
    totals.outputTokens = output;
    totals.totalTokens = total;
    totals.tokensIncomplete = false;
  }
  totals.estimatedCostCny = cost;
  return totals;
}

function preserveCost(previous: number | null | undefined, next: AiUsageTotals): AiUsageTotals {
  if (next.estimatedCostCny !== null) return next;
  if (typeof previous === "number" && Number.isFinite(previous)) {
    return { ...next, estimatedCostCny: previous };
  }
  return next;
}

function byStage(events: readonly AiUsageEvent[]): ProductAiUsage["byStage"] {
  const map = new Map<string, AiUsageEvent[]>();
  for (const event of events) {
    const key = event.stage || event.source;
    const list = map.get(key) ?? [];
    list.push(event);
    map.set(key, list);
  }
  return [...map.entries()].map(([stage, list]) => ({ stage, totals: sumTokens(list) }));
}

function latestRun(events: readonly AiUsageEvent[]): AiUsageTotals & { runId?: string } {
  const withRun = events.filter((event) => event.runId);
  if (withRun.length === 0) {
    return sumTokens(events);
  }
  let newest = withRun[0];
  for (const event of withRun) {
    if (event.startedAt > newest.startedAt) newest = event;
  }
  const runId = newest.runId!;
  return { ...sumTokens(events.filter((event) => event.runId === runId)), runId };
}

/** Append events by id (first write wins), cap at AI_USAGE_EVENT_CAP, recompute aggregates. */
export function appendAiUsage(
  existing: ProductAiUsage | undefined,
  incoming: readonly AiUsageEvent[],
): ProductAiUsage {
  const byId = new Map<string, AiUsageEvent>();
  for (const event of existing?.events ?? []) byId.set(event.id, event);
  for (const event of incoming) {
    if (byId.has(event.id)) continue;
    byId.set(event.id, event);
  }

  const events = [...byId.values()]
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id));
  const trimmed = events.length > AI_USAGE_EVENT_CAP
    ? events.slice(events.length - AI_USAGE_EVENT_CAP)
    : events;

  const lifetime = preserveCost(existing?.lifetime.estimatedCostCny, sumTokens(trimmed));
  const latest = latestRun(trimmed);
  const latestPreserved = existing?.latestRun.runId && existing.latestRun.runId === latest.runId
    ? preserveCost(existing.latestRun.estimatedCostCny, latest)
    : latest;

  return {
    events: trimmed,
    lifetime,
    latestRun: latestPreserved,
    byStage: byStage(trimmed),
  };
}
