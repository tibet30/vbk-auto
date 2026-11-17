/**
 * MCP 服务配置解析。
 *
 * 配置来自本机设置里的 `agentMcpServers`（JSON 数组）。解析采取"宁缺勿错"：
 * 非法 JSON 整体视为未配置，单条非法只跳过该条，绝不让坏配置拖垮智能体启动。
 */

import type { McpServerConfig } from "./client.js";

const MAX_SERVERS = 5;

export interface ParsedMcpServers {
  servers: McpServerConfig[];
  skipped: string[];
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function parseMcpServers(raw: string | undefined | null): ParsedMcpServers {
  if (!raw?.trim()) return { servers: [], skipped: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { servers: [], skipped: ["agentMcpServers 不是合法 JSON，已忽略"] };
  }
  if (!Array.isArray(parsed)) return { servers: [], skipped: ["agentMcpServers 必须是数组，已忽略"] };

  const servers: McpServerConfig[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of parsed.entries()) {
    const record = entry as Record<string, unknown>;
    const id = asString(record.id);
    const command = asString(record.command);
    if (!id || !command) {
      skipped.push(`第 ${index + 1} 条缺少 id 或 command，已跳过`);
      continue;
    }
    if (seen.has(id)) {
      skipped.push(`id 重复：${id}，已跳过`);
      continue;
    }
    if (servers.length >= MAX_SERVERS) {
      skipped.push(`超过 ${MAX_SERVERS} 个服务上限，${id} 已跳过`);
      continue;
    }
    seen.add(id);
    const args = Array.isArray(record.args) ? record.args.filter((arg): arg is string => typeof arg === "string") : [];
    const env = record.env && typeof record.env === "object" && !Array.isArray(record.env)
      ? Object.fromEntries(Object.entries(record.env as Record<string, unknown>)
        .filter((entry): entry is [string, string] => typeof entry[1] === "string"))
      : {};
    const label = asString(record.label);
    const timeoutMs = typeof record.timeoutMs === "number" && Number.isFinite(record.timeoutMs) && record.timeoutMs > 0
      ? record.timeoutMs
      : undefined;
    servers.push({
      id,
      command,
      args,
      env,
      ...(label ? { label } : {}),
      ...(timeoutMs ? { timeoutMs } : {}),
    });
  }
  return { servers, skipped };
}

/**
 * 设置页提交的配置校验：先归一化再写入，坏输入直接报错而不是静默落库。
 * env 不在此列——长期凭据不应写进设置表。
 */
export function validateMcpServersInput(
  input: readonly Record<string, unknown>[],
): { servers: McpServerConfig[]; error?: never } | { servers?: never; error: string } {
  if (!Array.isArray(input)) return { error: "配置必须是数组。" };
  if (input.length > MAX_SERVERS) return { error: `最多支持 ${MAX_SERVERS} 个外部服务。` };
  const seen = new Set<string>();
  const servers: McpServerConfig[] = [];
  for (const [index, entry] of input.entries()) {
    const nth = `第 ${index + 1} 个服务`;
    const id = asString(entry.id);
    const command = asString(entry.command);
    if (!id) return { error: `${nth}缺少 id。` };
    if (!/^[a-z0-9][a-z0-9-]*$/iu.test(id)) return { error: `${nth}的 id 只能用字母、数字与连字符：${id}` };
    if (seen.has(id)) return { error: `id 重复：${id}` };
    if (!command) return { error: `${nth}（${id}）缺少启动命令。` };
    const rawArgs = entry.args;
    if (rawArgs !== undefined && !Array.isArray(rawArgs)) return { error: `${nth}（${id}）的 args 必须是数组。` };
    const args = (rawArgs as unknown[] ?? []).filter((arg): arg is string => typeof arg === "string");
    const timeoutMs = typeof entry.timeoutMs === "number" && Number.isFinite(entry.timeoutMs) && entry.timeoutMs > 0
      ? Math.min(Math.round(entry.timeoutMs), 120_000)
      : undefined;
    const label = asString(entry.label);
    seen.add(id);
    servers.push({
      id,
      command,
      args,
      ...(label ? { label } : {}),
      ...(timeoutMs ? { timeoutMs } : {}),
    });
  }
  return { servers };
}
