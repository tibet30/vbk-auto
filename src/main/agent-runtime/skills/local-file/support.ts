/**
 * 本地文件 Skill 的共享工具：参数解析、差异预览与可恢复删除位置。
 */

import path from "node:path";

export const LOCAL_FILE_SKILL_ID = "local-file";
/** 本地文件设施统一账号键：同一账号的写动作串行。 */
export const LOCAL_FILE_ACCOUNT = "local-fs";
export const TRASH_DIRECTORY = ".agent-trash";
export const MAX_READ_BYTES = 64 * 1024;
const DIFF_LINE_LIMIT = 24;

export function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`缺少必填参数 ${key}。`);
  return value.trim();
}

export function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`参数 ${key} 必须是字符串。`);
  return value.trim() || undefined;
}

export function optionalBoolean(args: Record<string, unknown>, key: string): boolean {
  const value = args[key];
  if (value === undefined || value === null) return false;
  if (typeof value !== "boolean") throw new Error(`参数 ${key} 必须是布尔值。`);
  return value;
}

export function requireText(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string") throw new Error(`缺少必填参数 ${key}。`);
  return value;
}

/** 面向运营的紧凑差异预览：只标注新增/删除行，不做完整 patch。 */
export function buildDiff(before: string, after: string): string {
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  const removed: string[] = [];
  const added: string[] = [];
  const remaining = [...beforeLines];
  for (const line of afterLines) {
    const index = remaining.indexOf(line);
    if (index >= 0) remaining.splice(index, 1);
    else added.push(line);
  }
  removed.push(...remaining);
  if (!removed.length && !added.length) return "内容无变化";
  const lines = [
    ...removed.slice(0, DIFF_LINE_LIMIT).map((line) => `- ${line}`),
    ...added.slice(0, DIFF_LINE_LIMIT).map((line) => `+ ${line}`),
  ];
  const omitted = Math.max(0, removed.length - DIFF_LINE_LIMIT) + Math.max(0, added.length - DIFF_LINE_LIMIT);
  return omitted ? `${lines.join("\n")}\n…另有 ${omitted} 行未展示` : lines.join("\n");
}

export function trashRelativePath(absolute: string, root: string, now = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/gu, "-");
  const base = path.basename(absolute) || "item";
  return path.posix.join(TRASH_DIRECTORY, `${stamp}-${base}`).replace(/\\/gu, "/");
}
