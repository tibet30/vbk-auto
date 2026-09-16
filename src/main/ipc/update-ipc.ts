import { assertTrustedSender } from "../infrastructure/ipc-sender.js";
import { secureIpcMain as ipcMain } from "../infrastructure/ipc-sender.js";
import type { AppUpdateService } from "../application/app-update-service.js";

export function registerUpdateIpc(updateService: AppUpdateService): void {
  ipcMain.handle("updates:status", (event) => {
    assertTrustedSender(event, "updates:status");
    return updateService.snapshot();
  });
  ipcMain.handle("updates:check", (event) => {
    assertTrustedSender(event, "updates:check");
    return updateService.check();
  });
  ipcMain.handle("updates:download", (event) => {
    assertTrustedSender(event, "updates:download");
    return updateService.download();
  });
  ipcMain.handle("updates:openInstaller", (event) => {
    assertTrustedSender(event, "updates:openInstaller");
    return updateService.openInstaller();
  });
  ipcMain.handle("updates:showInstallerInFolder", (event) => {
    assertTrustedSender(event, "updates:showInstallerInFolder");
    return updateService.showInstallerInFolder();
  });
  ipcMain.handle("updates:quitAndInstall", (event) => {
    assertTrustedSender(event, "updates:quitAndInstall");
    updateService.quitAndInstall();
  });
}
