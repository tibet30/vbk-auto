// 产物解析与预览：收据里的产物路径必须仍落在任务授权目录内才允许打开。

import type { AgentArtifactPreview } from "../../shared/contracts-agent-runtime.js";
import type { MainIpcContext } from "../ipc/context.js";
import {
  buildArtifactPreview,
  resolveArtifactForOpen,
  type ResolvedArtifact,
} from "../agent-runtime/index.js";

export function resolveWorkspaceArtifact(input: {
  context: MainIpcContext;
  threadId: string;
  receiptId: string;
}): Promise<ResolvedArtifact> {
  const owner = input.context.getExtensionUserId();
  if (!owner || owner <= 0) throw new Error("请先登录应用账号。");
  const thread = input.context.db.getAgentThread(owner, input.threadId);
  if (!thread) throw new Error(`智能体任务不存在：${input.threadId}`);
  return resolveArtifactForOpen({
    db: input.context.db,
    ownerUserId: owner,
    threadId: input.threadId,
    receiptId: input.receiptId,
    ...(thread.workingDirectory ? { workingDirectory: thread.workingDirectory } : {}),
  });
}

export function previewWorkspaceArtifact(input: {
  context: MainIpcContext;
  threadId: string;
  receiptId: string;
}): Promise<AgentArtifactPreview> {
  const owner = input.context.getExtensionUserId();
  if (!owner || owner <= 0) throw new Error("请先登录应用账号。");
  const thread = input.context.db.getAgentThread(owner, input.threadId);
  if (!thread) throw new Error(`智能体任务不存在：${input.threadId}`);
  return buildArtifactPreview({
    db: input.context.db,
    ownerUserId: owner,
    threadId: input.threadId,
    receiptId: input.receiptId,
    ...(thread.workingDirectory ? { workingDirectory: thread.workingDirectory } : {}),
  });
}
