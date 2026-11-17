/**
 * 授权目录内的安全路径解析。
 *
 * 所有路径都在主进程解析，并且以授权目录的 `realpath` 为根校验目标的
 * `realpath`：绝对路径、`..` 越界、软链接越界、授权目录缺失都必须直接失败，
 * 不允许"取父目录"或"回退到当前目录"等隐式降级。
 */

import fs from "node:fs/promises";
import path from "node:path";

export type AgentPathScopeCode =
  | "missing_root"
  | "absolute_target"
  | "outside_root"
  | "symlink_escape"
  | "invalid_target";

export class AgentPathScopeError extends Error {
  constructor(readonly code: AgentPathScopeCode, message: string) {
    super(message);
    this.name = "AgentPathScopeError";
  }
}

export interface ScopedPath {
  /** 授权目录的真实路径。 */
  root: string;
  /** 目标绝对路径（仅做词法归一化，写入前仍需经真实路径校验）。 */
  absolute: string;
  /** 相对授权目录的路径，根目录为空串。 */
  relative: string;
  exists: boolean;
}

export function isPathInside(root: string, candidate: string): boolean {
  if (candidate === root) return true;
  return candidate.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`);
}

function assertNotAbsolute(raw: string): void {
  if (path.isAbsolute(raw) || /^[A-Za-z]:[\\/]/u.test(raw) || raw.startsWith("~")) {
    throw new AgentPathScopeError("absolute_target", `路径必须是授权目录内的相对路径：${raw}`);
  }
}

/** 逐级向上找最近存在的祖先，用于校验尚未创建的目标不会落在软链接外。 */
async function nearestExisting(target: string): Promise<string | undefined> {
  let current = target;
  for (;;) {
    try {
      await fs.lstat(current);
      return current;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return undefined;
      current = parent;
    }
  }
}

export async function resolveScopedPath(root: string | undefined, target: string): Promise<ScopedPath> {
  if (!root?.trim()) throw new AgentPathScopeError("missing_root", "当前任务还没有选择工作目录，请先授权一个目录。");
  let realRoot: string;
  try {
    realRoot = await fs.realpath(root);
  } catch {
    throw new AgentPathScopeError("missing_root", `授权目录不可用：${root}`);
  }
  const stats = await fs.lstat(realRoot).catch(() => undefined);
  if (!stats?.isDirectory()) throw new AgentPathScopeError("missing_root", `授权目录不是目录：${root}`);

  const raw = target?.trim() || ".";
  assertNotAbsolute(raw);
  const absolute = path.resolve(realRoot, raw);
  if (!isPathInside(realRoot, absolute)) {
    throw new AgentPathScopeError("outside_root", `路径超出授权目录：${raw}`);
  }

  const ancestor = await nearestExisting(absolute);
  if (!ancestor) throw new AgentPathScopeError("invalid_target", `无法解析目标路径：${raw}`);
  const realAncestor = await fs.realpath(ancestor);
  if (!isPathInside(realRoot, realAncestor)) {
    throw new AgentPathScopeError("symlink_escape", `路径经软链接越出授权目录：${raw}`);
  }

  const exists = ancestor === absolute;
  if (exists) {
    // 目标自身若为软链接，其真实位置也必须仍在授权目录内。
    const realTarget = await fs.realpath(absolute);
    if (!isPathInside(realRoot, realTarget)) {
      throw new AgentPathScopeError("symlink_escape", `目标软链接越出授权目录：${raw}`);
    }
  }

  return {
    root: realRoot,
    absolute,
    relative: path.relative(realRoot, absolute),
    exists,
  };
}

export async function requireScopedPath(root: string | undefined, target: string): Promise<ScopedPath> {
  const resolved = await resolveScopedPath(root, target);
  if (!resolved.exists) {
    throw new AgentPathScopeError("invalid_target", `目标不存在：${resolved.relative || "."}`);
  }
  return resolved;
}
