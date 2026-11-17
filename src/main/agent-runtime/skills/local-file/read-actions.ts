/**
 * 只读动作：列目录与读取文件。读取在授权目录内静默执行，但仍写入审计收据。
 */

import fs from "node:fs/promises";
import type { AgentSkillAction } from "../../types.js";
import { requireScopedPath } from "../../path-scope.js";
import { LOCAL_FILE_ACCOUNT, MAX_READ_BYTES, optionalString } from "./support.js";

const ENTRY_LIMIT = 200;

export const listAction: AgentSkillAction = {
  name: "file.list",
  kind: "read",
  label: "列目录",
  risk: "low",
  description: "列出授权目录内某个子目录的条目；path 省略时列出授权目录根。",
  parameters: {
    type: "object",
    properties: { path: { type: "string", description: "授权目录内的相对路径，省略表示根目录" } },
    additionalProperties: false,
  },
  async target(args, context) {
    const resolved = await requireScopedPath(context.workingDirectory, optionalString(args, "path") ?? ".");
    return { action: "file.list", targetKey: resolved.absolute, accountKey: LOCAL_FILE_ACCOUNT, risk: "low", directory: resolved.root };
  },
  async execute(args, context) {
    const resolved = await requireScopedPath(context.workingDirectory, optionalString(args, "path") ?? ".");
    const entries = await fs.readdir(resolved.absolute, { withFileTypes: true });
    const sorted = entries
      .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
      .sort((left, right) => left.localeCompare(right));
    const shown = sorted.slice(0, ENTRY_LIMIT);
    const label = resolved.relative || ".";
    return {
      content: shown.length
        ? `${label} 共 ${sorted.length} 项：\n${shown.join("\n")}${sorted.length > shown.length ? `\n…另有 ${sorted.length - shown.length} 项` : ""}`
        : `${label} 是空目录。`,
      summary: `列出 ${label}，共 ${sorted.length} 项。`,
      result: `列出 ${resolved.absolute}：${sorted.length} 项`,
    };
  },
};

export const readAction: AgentSkillAction = {
  name: "file.read",
  kind: "read",
  label: "读取文件",
  risk: "low",
  description: `读取授权目录内的文本文件；最多返回 ${MAX_READ_BYTES} 字节。`,
  parameters: {
    type: "object",
    properties: { path: { type: "string", description: "授权目录内文件的相对路径" } },
    required: ["path"],
    additionalProperties: false,
  },
  async target(args, context) {
    const resolved = await requireScopedPath(context.workingDirectory, optionalString(args, "path") ?? "");
    return { action: "file.read", targetKey: resolved.absolute, accountKey: LOCAL_FILE_ACCOUNT, risk: "low", directory: resolved.root };
  },
  async execute(args, context) {
    const resolved = await requireScopedPath(context.workingDirectory, optionalString(args, "path") ?? "");
    const stats = await fs.stat(resolved.absolute);
    if (!stats.isFile()) throw new Error(`目标不是文件：${resolved.relative}`);
    const handle = await fs.open(resolved.absolute, "r");
    try {
      const buffer = Buffer.alloc(Math.min(stats.size, MAX_READ_BYTES));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const text = buffer.subarray(0, bytesRead).toString("utf8");
      const truncated = stats.size > MAX_READ_BYTES;
      return {
        content: `${resolved.relative}（${stats.size} 字节${truncated ? "，已截断" : ""}）：\n${text}`,
        summary: `读取 ${resolved.relative}（${stats.size} 字节）。`,
        before: text,
        result: `读取 ${resolved.absolute}：${bytesRead} 字节`,
      };
    } finally {
      await handle.close();
    }
  },
};
