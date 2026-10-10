/**
 * AppUpdateService feed 周边常量与平台相关小工具：
 *   - APP_UPDATE_FEED_URL：默认更新源；
 *   - feedUrl：可用 VBK_UPDATE_FEED_URL 覆盖（本地联调）；
 *   - devForced：VBK_UPDATE_DEV_FORCE=1 让开发态也能预览更新界面；
 *   - isSupportedUpdatePlatform：只支持 macOS / Windows；
 *   - manifestFileName / installerKind：平台相关文件名与扩展名；
 *   - ensureTrailingSlash / normalizeProgress。
 */

export const APP_UPDATE_FEED_URL = "https://www.atdtour.com/downloads/sanrentongyou/updates/stable";
export const feedUrl = process.env.VBK_UPDATE_FEED_URL || APP_UPDATE_FEED_URL;
export const devForced = process.env.VBK_UPDATE_DEV_FORCE === "1";

export type SupportedUpdatePlatform = "darwin" | "win32";

export function isSupportedUpdatePlatform(platform: NodeJS.Platform): platform is SupportedUpdatePlatform {
  return platform === "darwin" || platform === "win32";
}

export function manifestFileName(): string {
  return process.platform === "win32" ? "latest.yml" : "latest-mac.yml";
}

export function installerKind(): { extension: ".dmg" | ".exe"; label: string } {
  return process.platform === "win32"
    ? { extension: ".exe", label: "Windows 安装包" }
    : { extension: ".dmg", label: "macOS 安装包" };
}

export function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

export function normalizeProgress(percent: number): number {
  if (!Number.isFinite(percent)) return 0;
  return Math.max(0, Math.min(100, Math.round(percent)));
}