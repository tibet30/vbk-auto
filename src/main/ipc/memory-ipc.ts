import type {
  MemoryFilter,
  MemoryInput,
  MemoryMaintenanceSettings,
  MemoryPatch,
} from "../../shared/contracts.js";
import { secureIpcMain as ipcMain } from "../infrastructure/ipc-sender.js";
import type { MainIpcContext } from "./context.js";

function requireMemoryService(context: MainIpcContext) {
  if (!context.memoryService) throw new Error("记忆服务尚未就绪，请重启应用后重试。");
  return context.memoryService;
}

function productScope(localProductId: string, input: Omit<MemoryInput, "ownerUserId" | "kind">) {
  return {
    ...input,
    scopeType: input.scopeType ?? "product",
    scopeKey: input.scopeKey ?? localProductId,
  };
}

export function registerMemoryIpc(context: MainIpcContext): void {
  ipcMain.handle("memory:saveExplicit", (_event, localProductId: string, input: Omit<MemoryInput, "ownerUserId" | "kind">) =>
    requireMemoryService(context).saveExplicit(productScope(localProductId, input)));

  ipcMain.handle("memory:list", (_event, localProductId: string, filter: MemoryFilter = {}) =>
    requireMemoryService(context).list({
      ...filter,
      scopeType: filter.scopeType ?? "product",
      scopeKey: filter.scopeKey ?? localProductId,
    }));

  ipcMain.handle("memory:get", (_event, _localProductId: string, id: string) =>
    requireMemoryService(context).get(id));

  ipcMain.handle("memory:update", (_event, _localProductId: string, id: string, patch: MemoryPatch) =>
    requireMemoryService(context).update(id, patch));

  ipcMain.handle("memory:disable", (_event, _localProductId: string, id: string) =>
    requireMemoryService(context).disable(id));

  ipcMain.handle("memory:delete", (_event, _localProductId: string, id: string) =>
    requireMemoryService(context).delete(id));

  ipcMain.handle("memory:maintenance", (_event, _localProductId: string) =>
    requireMemoryService(context).maintenance());

  ipcMain.handle("memory:settings", (_event, _localProductId: string, settings?: MemoryMaintenanceSettings) =>
    requireMemoryService(context).settings(settings));
}
