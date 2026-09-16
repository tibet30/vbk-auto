import fs from "node:fs";
import path from "node:path";
import { app, shell, type BrowserWindow } from "electron";
import electronUpdater from "electron-updater";
import type { ProgressInfo, UpdateInfo } from "electron-updater";
import type { AppUpdateState, AppUpdateStatus } from "../../shared/contracts.js";
import { logError, logInfo, logWarn } from "../../shared/log-timestamp.js";
import { AppUpdateFailure, describeUpdateFailure } from "./app-update-diagnostics.js";

export const APP_UPDATE_FEED_URL = "https://www.atdtour.com/downloads/sanrentongyou/updates/stable";
const feedUrl = process.env.VBK_UPDATE_FEED_URL || APP_UPDATE_FEED_URL;
/**
 * 在线更新只在打包后的 macOS 应用中启用：未打包时 app.getVersion() 读的是
 * 开发用的 package.json，产物目录也不存在，检查更新没有意义。
 * VBK_UPDATE_DEV_FORCE=1 仅供开发时预览更新界面与错误文案。
 */
const devForced = process.env.VBK_UPDATE_DEV_FORCE === "1";
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
    const supported = process.platform === "darwin" && (app.isPackaged || devForced);
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
      const manifest = parseLatestMacManifest(await fetchLatestMacManifest());
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
    throw new AppUpdateFailure("unsupported", "当前运行方式暂不支持在线更新，请使用 macOS 安装版。");
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
        percent: normalizeProgress(progress.percent),
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
    const manifest = parseLatestMacManifest(await fetchLatestMacManifest());
    const installerFile = selectDmgFile(manifest.source, version);
    const url = new URL(encodeURI(installerFile), ensureTrailingSlash(feedUrl)).toString();
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
    if (!fs.existsSync(installerPath)) throw new Error("安装包文件不存在，请重新下载。");
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
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return;
    window.webContents.send("updates:changed", this.snapshot());
  }
}

function normalizeProgress(percent: number): number {
  if (!Number.isFinite(percent)) return 0;
  return Math.max(0, Math.min(100, Math.round(percent)));
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

async function fetchLatestMacManifest(): Promise<string> {
  const manifestUrl = new URL("latest-mac.yml", ensureTrailingSlash(feedUrl));
  let response: Response;
  try {
    response = await fetch(manifestUrl);
  } catch (error) {
    throw new AppUpdateFailure(
      "feed_unreachable",
      "连接更新服务器失败，请确认本机网络可以访问更新源后重试。",
      error instanceof Error ? error.message : String(error),
    );
  }
  if (response.status === 404) {
    throw new AppUpdateFailure(
      "feed_missing",
      "更新源上还没有 latest-mac.yml，请先把 macOS 更新包上传到更新目录。",
      `HTTP 404 · ${manifestUrl.toString()}`,
    );
  }
  if (!response.ok) {
    throw new AppUpdateFailure(
      "feed_unreachable",
      `读取更新清单失败（HTTP ${response.status}），请稍后重试。`,
      manifestUrl.toString(),
    );
  }
  const contentType = response.headers.get("content-type") ?? "";
  const text = await response.text();
  const head = text.trimStart().slice(0, 160);
  if (contentType.includes("text/html") || /^<!doctype html|^<html/i.test(head)) {
    throw new AppUpdateFailure(
      "feed_missing",
      "更新源返回的是网站页面而不是 latest-mac.yml，说明服务器上还没有发布 macOS 更新文件。",
      `content-type: ${contentType || "unknown"} · 响应开头：${head.slice(0, 100)}`,
    );
  }
  if (!text.trim()) {
    throw new AppUpdateFailure("manifest_invalid", "更新清单是空文件，请重新上传 latest-mac.yml。");
  }
  return text;
}

function parseLatestMacManifest(source: string): { version: string; releaseDate?: string; source: string } {
  const version = source.match(/^version:\s*([^\s'"]+)\s*$/m)?.[1]?.trim();
  if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new AppUpdateFailure(
      "manifest_invalid",
      "更新清单缺少有效版本号，请确认 latest-mac.yml 已正确上传。",
      source.trim().slice(0, 160),
    );
  }
  const releaseDate = source.match(/^releaseDate:\s*['"]?([^'"\n]+)['"]?\s*$/m)?.[1]?.trim();
  return { version, releaseDate, source };
}

function compareSemver(left: string, right: string): number {
  const leftParts = left.split(".").map((part) => Number(part));
  const rightParts = right.split(".").map((part) => Number(part));
  for (let i = 0; i < 3; i += 1) {
    const delta = leftParts[i] - rightParts[i];
    if (delta !== 0) return delta;
  }
  return 0;
}

function selectDmgFile(manifest: string, version: string): string {
  const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = manifest.match(new RegExp(`url:\\s*([^\\n]+${escapedVersion}[^\\n]+\\.dmg)\\s*$`, "m"));
  if (match) return match[1].trim().replace(/^['"]|['"]$/g, "");
  const fallback = manifest.match(/url:\s*([^\n]+\.dmg)\s*$/m);
  if (fallback) return fallback[1].trim().replace(/^['"]|['"]$/g, "");
  throw new AppUpdateFailure(
    "installer_missing",
    "更新清单里没有找到 macOS 安装包（.dmg），请确认打包产物与清单一致后重新上传。",
  );
}

async function downloadFile(
  url: string,
  targetPath: string,
  onProgress: (progress: ProgressInfo) => void,
): Promise<void> {
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`下载安装包失败：${response.status}`);
  const total = Number(response.headers.get("content-length") || 0);
  const startedAt = Date.now();
  let transferred = 0;
  const file = fs.createWriteStream(targetPath);
  try {
    for await (const chunk of response.body) {
      const buffer = Buffer.from(chunk);
      transferred += buffer.byteLength;
      if (!file.write(buffer)) await new Promise((resolve) => file.once("drain", resolve));
      const elapsedSeconds = Math.max(1, (Date.now() - startedAt) / 1000);
      onProgress({
        total,
        transferred,
        percent: total ? (transferred / total) * 100 : 0,
        bytesPerSecond: Math.round(transferred / elapsedSeconds),
        delta: buffer.byteLength,
      });
    }
  } catch (error) {
    fs.rmSync(targetPath, { force: true });
    throw error;
  } finally {
    await new Promise<void>((resolve, reject) => {
      file.end((error?: Error | null) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
  if (transferred <= 0) {
    fs.rmSync(targetPath, { force: true });
    throw new Error("安装包下载为空，请重新下载。");
  }
}
