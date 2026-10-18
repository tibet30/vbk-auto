import type { AgentApprovalResponse, AgentIllegalKeywordRepairInput, AgentInputResponse, AgentSnapshot } from "../../shared/contracts.js";
import { agentDisplaySnapshot, agentHistoryPage } from "../../shared/agent-display.js";
import { sanitizeAgentSnapshot } from "../../shared/agent-snapshot-sanitize.js";
import { secureIpcMain as ipcMain } from "../infrastructure/ipc-sender.js";
import type { MainIpcContext } from "./context.js";

/** Agent IPC projects durable snapshots for renderer transport; full state stays in main/SQLite. */
export function registerAgentIpc(context: MainIpcContext): void {
  const agent = () => {
    if (!context.agentCore) throw new Error("Agent 服务尚未就绪，请重启应用后重试。");
    return context.agentCore;
  };
  /**
   * AgentCore 的 send/pause/resume 拿到的 snapshot 是 in-memory 未脱敏的
   * （落库路径 saveAgentSnapshot 会 sanitize，但返回到 IPC handler 的引用
   * 不是 sanitized）。所以这里统一 sanitize 一次后再广播与返给 renderer。
   */
  const emit = (snapshot: AgentSnapshot) => {
    const safe = sanitizeAgentSnapshot(snapshot);
    context.emitAgentSnapshot?.(safe);
    return agentDisplaySnapshot(safe);
  };
  ipcMain.handle("agent:get", (_event, localProductId: string) => agent().get(localProductId).then(emit));
  ipcMain.handle("agent:getHistory", (_event, localProductId: string, page: number) => agent().get(localProductId)
    .then((snapshot) => sanitizeAgentSnapshot(snapshot))
    .then((snapshot) => agentHistoryPage(snapshot.events, page)));
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
  ipcMain.handle("agent:createTrafficChildren", (_event, id: string, routeReviewAuthorized: boolean) => agent().createTrafficChildren(id, routeReviewAuthorized).then(emit));
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
