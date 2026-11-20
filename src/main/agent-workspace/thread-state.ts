// 任务状态派生：自动标题、运行状态到列表状态、任务目录可用性。
import fs from "node:fs";
import type { AgentRun } from "../../shared/contracts-agent-runtime.js";
import type { AgentThreadStatus } from "../../shared/contracts-agent-workspace.js";

export function automaticTitle(content: string): string {
  const oneLine = content.replace(/\s+/gu, " ").trim();
  return oneLine.length > 24 ? `${oneLine.slice(0, 24)}…` : oneLine || "新任务";
}

export function threadStatusFor(run: AgentRun | undefined): AgentThreadStatus {
  if (!run) return "waiting";
  if (run.status === "running" || run.status === "queued") return "running";
  if (run.status === "waiting_approval") return "waiting";
  if (run.status === "needs_attention" || run.status === "uncertain") return "needs_attention";
  return "waiting";
}

export function workingDirectoryAvailable(directory: string | undefined): boolean | undefined {
  if (!directory) return undefined;
  try {
    return fs.statSync(directory).isDirectory();
  } catch {
    return false;
  }
}
