import { secureIpcMain as ipcMain } from "../infrastructure/ipc-sender.js";
import type { TibetAuthService } from "../infrastructure/tibet-auth.js";

/** Register the application-level account gate. This is separate from VBK login IPC. */
export function registerAppAuthIpc(auth: TibetAuthService): void {
  ipcMain.handle("appAuth:status", () => auth.status());
  ipcMain.handle("appAuth:listAccounts", () => auth.listAccounts());
  ipcMain.handle("appAuth:captcha", () => auth.captcha());
  ipcMain.handle("appAuth:login", (_event, input) => auth.login(input));
  ipcMain.handle("appAuth:switchAccount", (_event, userId: number) => auth.switchAccount(userId));
  ipcMain.handle("appAuth:startLogin", () => auth.startLogin());
  ipcMain.handle("appAuth:logout", () => auth.logout());
}
