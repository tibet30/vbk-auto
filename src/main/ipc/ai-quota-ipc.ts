/** 网关额度查询的 IPC 入口：主进程持有登录态，渲染端只拿到额度快照。 */

import { fetchAiQuota, submitAiQuotaRequest } from "../infrastructure/ai-quota.js";
import type { AppAuthStore } from "../infrastructure/app-auth-store.js";
import { secureIpcMain as ipcMain } from "../infrastructure/ipc-sender.js";

export function registerAiQuotaIpc(getStore: () => AppAuthStore | null): void {
  ipcMain.handle("ai:quota", async () => {
    const store = getStore();
    if (!store) throw new Error("账号服务尚未就绪，请稍后重试。");
    return fetchAiQuota(store);
  });
  ipcMain.handle("ai:quotaRequest", async (_event, input: { requestedBillableTokens: number; reason: string }) => {
    const store = getStore();
    if (!store) throw new Error("账号服务尚未就绪，请稍后重试。");
    await submitAiQuotaRequest(store, input);
  });
}
