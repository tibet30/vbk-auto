import { dialog, shell } from "electron";
import { secureIpcMain as ipcMain } from "../infrastructure/ipc-sender.js";
import { AgentWorkspaceService } from "../agent-workspace/service.js";
import type { MainIpcContext } from "./context.js";

export function registerAgentWorkspaceIpc(context: MainIpcContext): void {
  const workspace = new AgentWorkspaceService(context);
  // 启动即收敛上次中断的运行：执行中的动作转 uncertain，半途运行退回 needs_attention。
  workspace.recover();
  ipcMain.handle("agentWorkspace:list", () => workspace.list());
  ipcMain.handle("agentWorkspace:create", (_event, input) => workspace.create(input));
  ipcMain.handle("agentWorkspace:get", (_event, id: string) => workspace.get(String(id ?? "")));
  ipcMain.handle("agentWorkspace:update", (_event, id: string, patch) => workspace.update(String(id ?? ""), patch));
  ipcMain.handle("agentWorkspace:send", (_event, id: string, content: string) => workspace.send(String(id ?? ""), String(content ?? "")));
  ipcMain.handle("agentWorkspace:approve", (_event, threadId: string, toolCallId: string, scope: string) =>
    workspace.approve(String(threadId ?? ""), String(toolCallId ?? ""), scope === "thread" ? "thread" : "once"));
  ipcMain.handle("agentWorkspace:reject", (_event, threadId: string, toolCallId: string, reason?: string) =>
    workspace.reject(String(threadId ?? ""), String(toolCallId ?? ""), reason ? String(reason) : undefined));
  ipcMain.handle("agentWorkspace:reconcile", (_event, threadId: string, toolCallId: string) =>
    workspace.reconcile(String(threadId ?? ""), String(toolCallId ?? "")));
  ipcMain.handle("agentWorkspace:previewArtifact", (_event, threadId: string, receiptId: string) =>
    workspace.previewArtifact(String(threadId ?? ""), String(receiptId ?? "")));
  ipcMain.handle("agentWorkspace:resume", (_event, threadId: string) => workspace.resume(String(threadId ?? "")));
  ipcMain.handle("agentWorkspace:capabilities", () => workspace.capabilities());
  ipcMain.handle("agentWorkspace:externalTools", () => workspace.externalTools.read());
  ipcMain.handle("agentWorkspace:saveExternalTools", (_event, servers: unknown) =>
    workspace.externalTools.save(Array.isArray(servers) ? servers as never : []));
  ipcMain.handle("agentWorkspace:refreshExternalTools", () => workspace.externalTools.refresh());
  ipcMain.handle("agentWorkspace:setExternalToolConnection", (_event, serverId: string, connected: unknown) =>
    workspace.externalTools.setConnection(String(serverId ?? ""), connected === true));
  ipcMain.handle("agentWorkspace:cancel", (_event, threadId: string) => workspace.cancel(String(threadId ?? "")));
  ipcMain.handle("agentWorkspace:openArtifact", async (_event, threadId: string, receiptId: string, mode: string) => {
    const target = await workspace.resolveArtifact(String(threadId ?? ""), String(receiptId ?? ""));
    if (mode === "reveal") {
      shell.showItemInFolder(target.openPath);
      return;
    }
    const failure = await shell.openPath(target.openPath);
    if (failure) throw new Error(`无法打开产物：${failure}`);
  });
  ipcMain.handle("agentWorkspace:selectDirectory", async (_event, id: string) => {
    const result = await dialog.showOpenDialog({
      title: "选择当前任务可访问的工作目录",
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || !result.filePaths[0]) return workspace.get(String(id ?? ""));
    workspace.update(String(id ?? ""), { workingDirectory: result.filePaths[0] });
    return workspace.get(String(id ?? ""));
  });
}
