import type { OperationLogEntry } from "../../shared/contracts.js";
import { redactLogString, redactLogValue } from "../../shared/log-redaction.js";

const HEADER = [
  "时间", "级别", "来源", "模块", "类型", "状态", "产品", "产品ID",
  "阶段", "步骤", "尝试次数", "耗时(ms)", "操作目标", "消息", "安全上下文",
];

function csvCell(value: unknown): string {
  const text = value == null ? "" : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

export function buildOperationLogCsv(entries: OperationLogEntry[]): string {
  const rows = entries.map((entry) => [
    entry.startedAt, entry.level ?? "info", entry.source ?? "automation", entry.module ?? "",
    entry.type, entry.status, entry.productName ?? "", entry.localProductId ?? "",
    entry.stage ?? "", entry.phase ?? "", entry.attempt, entry.durationMs,
    entry.target ? redactLogString(entry.target) : "",
    entry.message ? redactLogString(entry.message) : "",
    entry.context && Object.keys(entry.context).length ? JSON.stringify(redactLogValue(entry.context)) : "",
  ]);
  return `\uFEFF${[HEADER, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}
