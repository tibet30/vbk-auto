// 任务工作目录的落点解析：用户未指定目录时，为每个任务维护一个可回收的临时工作区。

import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentThread } from "../../shared/contracts-agent-workspace.js";

export const TEMPORARY_WORKSPACE_ROOT_ENV = "VBK_AGENT_WORKSPACE_ROOT";

const THREAD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export function resolveTemporaryWorkspaceRoot(override?: string): string {
  const fromOverride = override?.trim();
  if (fromOverride) return path.resolve(fromOverride);
  const fromEnv = process.env[TEMPORARY_WORKSPACE_ROOT_ENV]?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  return path.join(os.tmpdir(), "vbk-agent-workspaces");
}

export function automaticWorkspacePath(root: string, ownerUserId: number, threadId: string): string {
  return path.join(root, String(ownerUserId), threadId);
}

async function isDirectory(directory: string): Promise<boolean> {
  try {
    return (await fsPromises.stat(directory)).isDirectory();
  } catch {
    return false;
  }
}

function removeDirectory(directory: string): boolean {
  try {
    fs.rmSync(directory, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

function childDirectories(directory: string): string[] {
  try {
    return fs.readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

export class ThreadWorkspaceDirectory {
  constructor(readonly root: string) {}

  pathOf(thread: { ownerUserId: number; id: string }): string {
    return automaticWorkspacePath(this.root, thread.ownerUserId, thread.id);
  }

  kind(thread: { ownerUserId: number; id: string; workingDirectory?: string }): "temporary" | "user" | undefined {
    const directory = thread.workingDirectory?.trim();
    if (!directory) return undefined;
    return path.resolve(directory) === path.resolve(this.pathOf(thread)) ? "temporary" : "user";
  }

  async resolve(thread: AgentThread): Promise<string> {
    const directory = thread.workingDirectory?.trim();
    if (directory) {
      if (await isDirectory(directory)) return directory;
      if (this.kind(thread) === "user") return directory;
    }
    return this.ensure(thread);
  }

  async ensure(thread: { ownerUserId: number; id: string }): Promise<string> {
    const target = this.pathOf(thread);
    await fsPromises.mkdir(target, { recursive: true, mode: 0o700 });
    return target;
  }

  release(thread: AgentThread): boolean {
    if (this.kind(thread) !== "temporary") return false;
    return removeDirectory(this.pathOf(thread));
  }

  prune(lookup: (ownerUserId: number, threadId: string) => string | undefined): number {
    let removed = 0;
    for (const owner of childDirectories(this.root)) {
      const ownerUserId = Number(owner);
      if (!Number.isInteger(ownerUserId) || ownerUserId <= 0) continue;
      for (const threadId of childDirectories(path.join(this.root, owner))) {
        if (!THREAD_ID_PATTERN.test(threadId)) continue;
        const directory = path.join(this.root, owner, threadId);
        const recorded = lookup(ownerUserId, threadId);
        if (recorded && path.resolve(recorded) === path.resolve(directory)) continue;
        if (removeDirectory(directory)) removed += 1;
      }
    }
    return removed;
  }
}
