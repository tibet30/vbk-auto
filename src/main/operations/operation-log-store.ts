/**
 * 操作日志的持久化层。
 *
 * 历史版本：返回固定 SAMPLE_ENTRIES（开发期 UI 打磨用）。
 * 当前版本：直接读写 `operation_log` 表（Sqlite via VbkDatabase）。
 *   - 写入入口：appendOperationLog —— 任何能拿到 VbkDatabase 句柄的
 *     地方都可以直接调，用于自动化运行期实时写日志；
 *   - 读取入口：loadOperationLog —— 保留同款 query 语义，让 renderer
 *     / IPC 调用方不动一行代码就切到真实数据；
 *   - 上限：1000 行（见 VbkDatabase.OPERATION_LOG_CAP）。
 *
 * 文件不依赖 Electron，便于在测试 / node-only 环境里跑。
 */

import { randomUUID } from "node:crypto";
import type { OperationLogEntry, OperationLogPage, OperationLogQuery, OperationLogSummary, OperationStatus } from "../../shared/contracts.js";
import { VbkDatabase } from "../infrastructure/database/database.js";

/** 当前操作日志的 DB 句柄。main 进程启动时通过 setOperationLogDb 注入。 */
let currentDb: VbkDatabase | undefined;

/**
 * 注入 DB 句柄。main 进程 createWindow 之前调用一次；测试环境直接传
 *   in-memory VbkDatabase 即可。
 * - 接受 undefined：用于 IPC 注入失败时回退到空响应（不抛错）。
 */
export function setOperationLogDb(db: VbkDatabase | undefined): void {
  currentDb = db;
}

/**
 * 兼容旧入口：保留 loadOperationLog(query) 单独签名。
 * 内部：未注入 DB 时返回空 page（避免 renderer 看到一堆 SAMPLE）。
 */
export function loadOperationLog(query: OperationLogQuery = {}): OperationLogPage {
  if (!currentDb) return emptyPage();
  return loadOperationLogFromDb(currentDb, query);
}

/**
 * 写入一条操作日志。提供给 automation runner 调用。
 *   - id 不传时生成 UUID；
 *   - status=running 表示「进行中」，会在 UI 卡片露出；
 *   - durationMs：完成时由 caller 传入。
 */
export function appendOperationLog(
  entry: Pick<OperationLogEntry, "type" | "name"> &
    Partial<Omit<OperationLogEntry, "id" | "type" | "name">> & {
      id?: string;
    },
): void {
  if (!currentDb) return;
  const id = entry.id || randomUUID();
  currentDb.appendOperationLog({
    id,
    type: entry.type,
    name: entry.name,
    status: entry.status ?? "succeeded",
    startedAt: entry.startedAt ?? new Date().toISOString(),
    durationMs: entry.durationMs ?? 0,
    attempt: entry.attempt ?? 1,
    localProductId: entry.localProductId,
    productName: entry.productName,
    stage: entry.stage,
    phase: entry.phase,
    target: entry.target,
    message: entry.message,
    payload: (entry as { payload?: Record<string, unknown> }).payload,
  });
}

/**
 * 返回状态过滤栏的可选值与中文标签（all / failed / succeeded / skipped / running）。
 * 与旧实现保持一致；调用方在 UI 渲染选项时直接用。
 */
export function listOperationStatusOptions(): Array<{ value: OperationStatus | "all"; label: string }> {
  return [
    { value: "all", label: "全部状态" },
    { value: "failed", label: "失败" },
    { value: "succeeded", label: "成功" },
    { value: "skipped", label: "跳过" },
    { value: "running", label: "进行中" },
  ];
}

// ─────────────────────────────────────────────────────────────────────
// 内部：从 DB 拉数据 → 拼 OperationLogPage
// ─────────────────────────────────────────────────────────────────────

function loadOperationLogFromDb(db: VbkDatabase, query: OperationLogQuery): OperationLogPage {
  const rows = db.queryOperationLog({
    status: query.status,
    type: query.type,
    stage: query.stage,
    localProductId: query.localProductId,
    query: query.query,
    limit: query.limit,
  });
  const entries: OperationLogEntry[] = rows.map((row) => ({
    id: row.id,
    localProductId: row.localProductId ?? "",
    productName: row.productName ?? "",
    type: row.type as OperationLogEntry["type"],
    name: row.name,
    status: row.status as OperationLogEntry["status"],
    stage: row.stage ?? undefined,
    phase: row.phase ?? undefined,
    attempt: row.attempt,
    startedAt: row.startedAt,
    durationMs: row.durationMs,
    target: row.target ?? undefined,
    message: row.message ?? undefined,
  }));
  const stages = Array.from(new Set(entries.map((entry) => entry.stage).filter(Boolean))) as string[];
  return {
    summary: summarize(entries),
    entries,
    stages,
    refreshedAt: new Date().toISOString(),
  };
}

/**
 * 计算 summary：succeeded / failed / skipped / running 各自数量。
 * 这里选择"基于当前 query 的结果"统计，而不是全局：与 UI 期望一致
 * （status filter 切换后顶部数字应跟着变）。
 */
function summarize(entries: OperationLogEntry[]): OperationLogSummary {
  const summary: OperationLogSummary = { total: entries.length, succeeded: 0, failed: 0, skipped: 0, running: 0 };
  for (const entry of entries) {
    if (entry.status === "succeeded") summary.succeeded += 1;
    else if (entry.status === "failed") summary.failed += 1;
    else if (entry.status === "skipped") summary.skipped += 1;
    else if (entry.status === "running") summary.running += 1;
  }
  return summary;
}

function emptyPage(): OperationLogPage {
  return {
    summary: { total: 0, succeeded: 0, failed: 0, skipped: 0, running: 0 },
    entries: [],
    stages: [],
    refreshedAt: new Date().toISOString(),
  };
}
