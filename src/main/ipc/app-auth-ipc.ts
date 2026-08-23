import type { AppAuthStatus, AppAuthUser } from "../../shared/contracts-auth.js";
import { secureIpcMain as ipcMain } from "../infrastructure/ipc-sender.js";
import type { TibetAuthService } from "../infrastructure/tibet-auth.js";

export type AppAuthAuthenticatedSource = "status" | "login" | "switchAccount";

export type AppAuthIpcOptions = {
  /** Fired after status/login/switchAccount yields an authenticated user. */
  onAuthenticated?: (user: AppAuthUser, source: AppAuthAuthenticatedSource) => void | Promise<void>;
};

function notifyAuthenticated(
  status: AppAuthStatus,
  source: AppAuthAuthenticatedSource,
  onAuthenticated?: AppAuthIpcOptions["onAuthenticated"],
): AppAuthStatus {
  if (status.state === "authenticated" && onAuthenticated) {
    void Promise.resolve(onAuthenticated(status.user, source)).catch(() => undefined);
  }
  return status;
}

/** Register the application-level account gate. This is separate from VBK login IPC. */
export function registerAppAuthIpc(auth: TibetAuthService, options: AppAuthIpcOptions = {}): void {
  const { onAuthenticated } = options;
  ipcMain.handle("appAuth:status", async () =>
    notifyAuthenticated(await auth.status(), "status", onAuthenticated));
  ipcMain.handle("appAuth:listAccounts", () => auth.listAccounts());
  ipcMain.handle("appAuth:captcha", () => auth.captcha());
  ipcMain.handle("appAuth:login", async (_event, input) =>
    notifyAuthenticated(await auth.login(input), "login", onAuthenticated));
  ipcMain.handle("appAuth:switchAccount", async (_event, userId: number) =>
    notifyAuthenticated(await auth.switchAccount(userId), "switchAccount", onAuthenticated));
  ipcMain.handle("appAuth:startLogin", () => auth.startLogin());
  ipcMain.handle("appAuth:logout", () => auth.logout());
}
