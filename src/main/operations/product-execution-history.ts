import type Database from "better-sqlite3";
import type { AgentSnapshot, AutomationRun } from "../../shared/contracts.js";
import type { ProductExecutionTime } from "../../shared/product-execution-time.js";

type Interval = [number, number];
const timestamp = (value: unknown) => typeof value === "string" ? Date.parse(value) : NaN;

export function unionDuration(intervals: Interval[]): number {
  const sorted = intervals.filter(([start, end]) => Number.isFinite(start) && Number.isFinite(end) && end > start)
    .sort((a, b) => a[0] - b[0]);
  let total = 0, start = 0, end = 0;
  for (const [nextStart, nextEnd] of sorted) {
    if (nextStart > end) { total += end - start; start = nextStart; end = nextEnd; }
    else end = Math.max(end, nextEnd);
  }
  return total + end - start;
}

/** Conservative read-only reconstruction: no creation-to-now inference. */
export function historicalExecutionTime(db: Database.Database, id: string): ProductExecutionTime {
  const intervals: Interval[] = [];
  const row = db.prepare("SELECT snapshot_json FROM agent_snapshots WHERE local_product_id=?").get(id) as { snapshot_json: string } | undefined;
  const snapshot = parse<AgentSnapshot>(row?.snapshot_json);
  const calls = new Map<string, { at: number; name: string }>();
  const exclusions: Interval[] = [];
  let suspendedAt: number | undefined;
  for (const event of snapshot?.events ?? []) {
    const at = timestamp(event.createdAt);
    const data = event.data ?? {};
    if (typeof data.waitSeconds === "number" && data.waitSeconds > 0) exclusions.push([at, at + data.waitSeconds * 1000]);
    if (event.type === "status" && typeof data.status === "string") {
      if (data.status === "running") {
        if (suspendedAt !== undefined) exclusions.push([suspendedAt, at]);
        suspendedAt = undefined;
      } else if (suspendedAt === undefined) suspendedAt = at;
    }
    const usage = data.aiUsage as { startedAt?: string; endedAt?: string; durationMs?: number } | undefined;
    if (usage) {
      const start = timestamp(usage.startedAt);
      const end = timestamp(usage.endedAt);
      intervals.push([start, Number.isFinite(end) ? end : start + Number(usage.durationMs ?? 0)]);
    }
    if (event.type === "tool_call" && typeof data.toolCallId === "string") {
      calls.set(data.toolCallId, { at, name: String(data.name ?? event.content) });
    }
    if (event.type === "tool_result" && typeof data.toolCallId === "string") {
      const call = calls.get(data.toolCallId);
      if (call && !["ask_user", "request_approval"].includes(call.name)) intervals.push([call.at, at]);
      calls.delete(data.toolCallId);
    }
  }
  if (suspendedAt !== undefined) exclusions.push([suspendedAt, Date.now()]);
  const runs = db.prepare("SELECT payload_json FROM automation_runs WHERE local_product_id=?").all(id) as { payload_json: string }[];
  for (const row of runs) {
    const run = parse<AutomationRun>(row.payload_json);
    // A retry can retain prior logs. Only contiguous, evidenced segments count.
    let start: number | undefined;
    let last: number | undefined;
    for (const log of run?.logs ?? []) {
      const at = timestamp(log.at);
      if (!Number.isFinite(at)) continue;
      if (start !== undefined && last !== undefined && at - last > 120_000) {
        intervals.push([start, last]); start = undefined;
      }
      if (/正在创建 VBK|正在保存：|阶段开始|重试|继续.*录入/.test(log.message)) start ??= at;
      last = at;
      if (start !== undefined && (log.level === "error" || /中止|已停止|草稿已保存/.test(log.message))) {
        intervals.push([start, at]); start = undefined;
      }
    }
    if (start !== undefined && last !== undefined) intervals.push([start, last]);
  }
  const recorded = db.prepare("SELECT started_at,duration_ms FROM operation_log WHERE local_product_id=? AND duration_ms>0 AND type!='wait' AND type!='runtime'").all(id) as { started_at: string; duration_ms: number }[];
  for (const log of recorded) intervals.push([timestamp(log.started_at), timestamp(log.started_at) + log.duration_ms]);
  const clipped = intervals.flatMap(([start, end]) => {
    let pieces: Interval[] = [[start, end]];
    for (const [pauseStart, pauseEnd] of exclusions) pieces = pieces.flatMap(([a, b]) => {
      if (pauseEnd <= a || pauseStart >= b) return [[a, b]] as Interval[];
      return [[a, Math.min(b, pauseStart)], [Math.max(a, pauseEnd), b]] as Interval[];
    });
    return pieces;
  });
  const product = db.prepare("SELECT created_at FROM products WHERE id=?").get(id) as { created_at: string } | undefined;
  const migration = db.prepare("SELECT applied_at FROM migrations WHERE id='0015_product_execution_time'").get() as { applied_at: string } | undefined;
  const predatesClock = product && timestamp(product.created_at) < timestamp(migration?.applied_at ?? new Date().toISOString());
  return { elapsedMs: unionDuration(clipped), running: false, historicalIncomplete: Boolean(row || runs.length || recorded.length || predatesClock) };
}

function parse<T>(value: string | undefined): T | undefined {
  try { return value ? JSON.parse(value) as T : undefined; } catch { return undefined; }
}
