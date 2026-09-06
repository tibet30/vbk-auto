import type { AgentApprovalResponse, AgentIllegalKeywordRepairInput, AgentInputResponse } from "../../shared/contracts.js";
import { secureIpcMain as ipcMain } from "../infrastructure/ipc-sender.js";
import type { MainIpcContext } from "./context.js";

/** Agent IPC deliberately returns the full durable snapshot after every operation. */
export function registerAgentIpc(context: MainIpcContext): void {
  const agent = () => {
    if (!context.agentCore) throw new Error("Agent 服务尚未就绪，请重启应用后重试。");
    return context.agentCore;
  };
  const emit = (snapshot: Awaited<ReturnType<NonNullable<MainIpcContext["agentCore"]>["get"]>>) => {
    context.emitAgentSnapshot?.(snapshot);
    return snapshot;
  };
  ipcMain.handle("agent:get", (_event, localProductId: string) => agent().get(localProductId).then(emit));
  ipcMain.handle("agent:send", (_event, localProductId: string, content: string) => {
    context.memoryService?.captureExplicitFromUserMessage(content, {
      localProductId,
      sourceKind: "agent:user",
    });
    return agent().send(localProductId, content).then(emit);
  });
  ipcMain.handle("agent:repairIllegalKeywords", (_event, localProductId: string, input: AgentIllegalKeywordRepairInput) => {
    const request = normaliseIllegalKeywordRepairInput(input);
    context.memoryService?.captureExplicitFromUserMessage(request.content, {
      localProductId,
      sourceKind: "agent:user",
    });
    return agent().repairIllegalKeywords(localProductId, request).then(emit);
  });
  ipcMain.handle("agent:respond", (_event, localProductId: string, response: AgentInputResponse) => {
    for (const value of Object.values(response.answers)) {
      const text = Array.isArray(value) ? value.join("\n") : value;
      context.memoryService?.captureExplicitFromUserMessage(text, {
        localProductId,
        sourceKind: "agent:response",
        sourceEventId: response.requestId,
      });
    }
    return agent().respond(localProductId, response).then(emit);
  });
  ipcMain.handle("agent:approve", (_event, localProductId: string, response: AgentApprovalResponse) => agent().approve(localProductId, response).then(emit));
  ipcMain.handle("agent:pause", (_event, localProductId: string) => agent().pause(localProductId).then(emit));
  ipcMain.handle("agent:resume", (_event, localProductId: string) => agent().resume(localProductId).then(emit));
  ipcMain.handle("agent:abandon", (_event, localProductId: string) => agent().abandon(localProductId).then(emit));
}

function normaliseIllegalKeywordRepairInput(input: AgentIllegalKeywordRepairInput): AgentIllegalKeywordRepairInput {
  const content = typeof input?.content === "string" ? input.content.trim() : "";
  if (!content) throw new Error("缺少非法关键词修复说明。");
  const keywords = Array.from(new Set((Array.isArray(input.keywords) ? input.keywords : [])
    .map((item) => String(item ?? "").trim())
    .filter(Boolean)));
  const affectedPaths = Array.from(new Set((Array.isArray(input.affectedPaths) ? input.affectedPaths : [])
    .map((item) => String(item ?? "").trim())
    .filter(Boolean)));
  return { content, keywords, affectedPaths };
}
