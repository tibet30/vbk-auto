// 任务工作区视图组装：把线程、运行快照、外部工具与工作目录来源合成界面契约。

import type { AgentThreadDetail } from "../../shared/contracts-agent-workspace.js";
import type {
  AgentExternalToolStatus,
  AgentRuntimeSnapshot,
  AgentThreadWorkingDirectoryKind,
  AgentThreadWorkspace,
} from "../../shared/contracts-agent-runtime.js";
import type { AgentModelMessage } from "../agent/types.js";
import { assembleThreadContext } from "./context-compression.js";
import { workingDirectoryAvailable } from "./thread-state.js";

export function composeWorkspaceView(input: {
  detail: AgentThreadDetail;
  runtime: AgentRuntimeSnapshot;
  externalTools: AgentExternalToolStatus[];
  workingDirectoryKind?: AgentThreadWorkingDirectoryKind;
}): AgentThreadWorkspace {
  const { detail, runtime, externalTools, workingDirectoryKind } = input;
  const base = {
    ...detail,
    runtime: externalTools.length ? { ...runtime, externalTools } : runtime,
    ...(workingDirectoryKind ? { workingDirectoryKind } : {}),
  };
  const available = workingDirectoryAvailable(detail.thread.workingDirectory);
  return available === undefined ? base : { ...base, workingDirectoryAvailable: available };
}

export function historyMessages(
  detail: AgentThreadDetail,
  summary: AgentThreadDetail["thread"]["summary"],
): AgentModelMessage[] {
  const assembled = assembleThreadContext({ messages: detail.messages, summary });
  return assembled.messages.map((message) => ({ role: message.role, content: message.content }));
}
