/**
 * AppUpdateService 主类（barrel）：
 *   - 管理 AppUpdateState（currentVersion / platform / supported / status / progress …）；
 *   - 串起 autoUpdater 事件 → patch + 通过 safeRendererSend 广播到 renderer；
 *   - 自动检查（启动延时 + 周期）；
 *   - 应用层手动检查 / 下载 / 打开 / 显示文件 / 退出并安装。
 *
 * 子文件分工：
 *   - feed.ts：feed URL + 平台判定 + ensureTrailingSlash + normalizeProgress；
 *   - manifest.ts：fetchLatestManifest + parseLatestManifest + compareSemver；
 *   - download.ts：selectInstallerFile + downloadFile；
 *   - diagnostics.ts（外部）：AppUpdateFailure + describeUpdateFailure。
 */

import fs from "node:fs";
import path from "node:path";
import { app, shell, type BrowserWindow } from "electron";
import electronUpdater from "electron-updater";
import type { ProgressInfo, UpdateInfo } from "electron-updater";
import type { AppUpdateState, AppUpdateStatus } from "../../shared/contracts.js";
import { logError, logInfo, logWarn } from "../../shared/log-timestamp.js";
import { safeRendererSend } from "../infrastructure/renderer-send.js";
import { AppUpdateFailure, describeUpdateFailure } from "./app-update-diagnostics.js";
import { downloadFile, ensureTrailingSlashUrl, selectInstallerFile } from "./app-update-service/download.js";
import { devForced, feedUrl, isSupportedUpdatePlatform } from "./app-update-service/feed.js";
import { compareSemver, fetchLatestManifest, parseLatestManifest } from "./app-update-service/manifest.js";

export { APP_UPDATE_FEED_URL } from "./app-update-service/feed.js";

const { autoUpdater } = electronUpdater;

export interface AppUpdateServiceOptions {
  getWindow: () => BrowserWindow | undefined;
  onQuitAndInstall: () => void;
}

export class AppUpdateService {
  private state: AppUpdateState;
  private checking = false;
  private downloading = false;
  private startupTimer: NodeJS.Timeout | null = null;
  private periodicTimer: NodeJS.Timeout | null = null;

  constructor(private readonly options: AppUpdateServiceOptions) {
    const supported = isSupportedUpdatePlatform(process.platform) && (app.isPackaged || devForced);
    this.state = {
      currentVersion: app.getVersion(),
      platform: process.platform,
      supported,
      feedUrl,
      status: supported ? "idle" : "unsupported",
      updateAvailable: false,
      downloaded: false,
    };
    if (!supported) return;
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.allowDowngrade = false;
    autoUpdater.setFeedURL({ provider: "generic", url: feedUrl });
    autoUpdater.logger = {
      info: (message?: unknown) => logInfo("[updates]", message),
      warn: (message?: unknown) => logWarn("[updates]", message),
      error: (message?: unknown) => logError("[updates]", message),
    };
    autoUpdater.on("checking-for-update", () => this.patch({ status: "checking", errorMessage: undefined }));
    autoUpdater.on("update-available", (info) => this.noteAvailable(info));
    autoUpdater.on("update-not-available", () => this.patch({ status: "not_available", updateAvailable: false }));
    autoUpdater.on("download-progress", (progress) => this.noteProgress(progress));
    autoUpdater.on("update-downloaded", (info) => this.noteDownloaded(info));
    autoUpdater.on("error", (error) => this.noteError(error));
  }

  snapshot(): AppUpdateState {
    return { ...this.state, progress: this.state.progress ? { ...this.state.progress } : undefined };
  }

  scheduleStartupCheck(delayMs = 20_000): void {
    if (!this.state.supported || this.startupTimer) return;
    this.startupTimer = setTimeout(() => {
      this.startupTimer = null;
      void this.check().catch((error) => logWarn("[updates] startup check skipped", error));
    }, delayMs);
  }

  /** 周期性自动检查，让全局状态栏的更新标识不会长期停留在过期结论上。 */
  schedulePeriodicCheck(intervalMs = 6 * 60 * 60 * 1000): void {
    if (!this.state.supported || this.periodicTimer) return;
    this.periodicTimer = setInterval(() => {
      void this.check().catch((error) => logWarn("[updates] periodic check skipped", error));
    }, intervalMs);
    this.periodicTimer.unref?.();
  }

  async check(): Promise<AppUpdateState> {
    this.assertSupported();
    if (this.checking || this.downloading) return this.snapshot();
    this.checking = true;
    this.patch({ status: "checking", errorMessage: undefined, errorCode: undefined, errorDetail: undefined });
    try {
      const manifest = parseLatestManifest(await fetchLatestManifest());
      if (compareSemver(manifest.version, app.getVersion()) <= 0) {
        this.patch({ status: "not_available", updateAvailable: false, downloaded: false });
      } else {
        this.patch({
          status: "available",
          updateAvailable: true,
          availableVersion: manifest.version,
          releaseDate: manifest.releaseDate,
          progress: undefined,
          downloaded: false,
          installerPath: undefined,
        });
      }
    } catch (error) {
      this.noteError(error);
    } finally {
      this.checking = false;
      this.patch({ checkedAt: new Date().toISOString() });
    }
    return this.snapshot();
  }

  async download(): Promise<AppUpdateState> {
    this.assertSupported();
    if (!this.state.updateAvailable) throw new Error("当前没有可下载的新版本。");
    if (this.state.downloaded || this.downloading) return this.snapshot();
    this.downloading = true;
    this.patch({ status: "downloading", errorMessage: undefined, errorCode: undefined, errorDetail: undefined });
    try {
      if (this.state.availableVersion) {
        const installerPath = await this.downloadInstaller(this.state.availableVersion);
        this.patch({ status: "downloaded", downloaded: true, installerPath });
      } else {
        await autoUpdater.downloadUpdate();
      }
      return this.snapshot();
    } catch (error) {
      this.noteError(error);
      return this.snapshot();
    } finally {
      this.downloading = false;
    }
  }

  async openInstaller(): Promise<void> {
    const installerPath = this.requireInstallerPath();
    const errorMessage = await shell.openPath(installerPath);
    if (errorMessage) throw new Error(errorMessage);
  }

  showInstallerInFolder(): void {
    shell.showItemInFolder(this.requireInstallerPath());
  }

  quitAndInstall(): void {
    this.assertSupported();
    if (!this.state.downloaded) throw new Error("新版本尚未下载完成。");
    this.options.onQuitAndInstall();
    autoUpdater.quitAndInstall(false, true);
  }

  private assertSupported(): void {
    if (this.state.supported) return;
    throw new AppUpdateFailure("unsupported", "当前运行方式暂不支持在线更新，请使用 macOS 或 Windows 安装版。");
  }

  private noteAvailable(info: UpdateInfo): void {
    this.patch({
      status: "available",
      updateAvailable: true,
      availableVersion: info.version,
      releaseDate: info.releaseDate,
      progress: undefined,
      downloaded: false,
    });
  }

  private noteProgress(progress: ProgressInfo): void {
    this.patch({
      status: "downloading",
      progress: {
        percent: Math.max(0, Math.min(100, Math.round(progress.percent || 0))),
        transferred: progress.transferred,
        total: progress.total,
        bytesPerSecond: progress.bytesPerSecond,
      },
    });
  }

  private noteDownloaded(info: UpdateInfo): void {
    this.patch({
      status: "downloaded",
      updateAvailable: true,
      availableVersion: info.version,
      releaseDate: info.releaseDate,
      downloaded: true,
    });
  }

  private async downloadInstaller(version: string): Promise<string> {
    const manifest = parseLatestManifest(await fetchLatestManifest());
    const installerFile = selectInstallerFile(manifest.source, version);
    const url = new URL(encodeURI(installerFile), ensureTrailingSlashUrl(feedUrl)).toString();
    const targetPath = path.join(app.getPath("downloads"), installerFile);
    const temporaryPath = `${targetPath}.download`;
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    try {
      await downloadFile(url, temporaryPath, (progress) => this.noteProgress(progress));
    } catch (error) {
      if (error instanceof AppUpdateFailure) throw error;
      const detail = error instanceof Error ? error.message : String(error);
      throw new AppUpdateFailure("download_failed", "安装包下载失败，请检查网络后重新下载。", detail);
    }
    fs.renameSync(temporaryPath, targetPath);
    return targetPath;
  }

  private requireInstallerPath(): string {
    const installerPath = this.state.installerPath;
    if (!installerPath) throw new Error("安装包尚未下载完成。");
    if (!fsPathExists(installerPath)) throw new Error("安装包文件不存在，请重新下载。");
    return installerPath;
  }

  private noteError(error: unknown): void {
    const failure = describeUpdateFailure(error);
    logWarn("[updates] check failed", { code: failure.code, message: failure.message, detail: failure.detail });
    this.patch({
      status: "error",
      errorCode: failure.code,
      errorMessage: failure.message,
      errorDetail: failure.detail,
    });
  }

  private patch(patch: Partial<AppUpdateState> & { status?: AppUpdateStatus }): void {
    this.state = { ...this.state, ...patch };
    const window = this.options.getWindow();
    safeRendererSend(window, "updates:changed", this.snapshot());
  }
}

function fsPathExists(value: string): boolean {
  return fs.existsSync(value);
}