import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

export const PLACEHOLDER_COVER_FILE_NAME = "operator-placeholder-cover.png";

/** Reads the bundled image as bytes so Playwright can upload it even from an ASAR package. */
export function loadPlaceholderCoverAsset(appPath?: string): { name: string; mimeType: "image/png"; buffer: Buffer } {
  const root = appPath ?? (createRequire(import.meta.url)("electron") as typeof import("electron")).app.getAppPath();
  const sourceAsset = join(root, "src", "renderer", "assets", "cover-fallback.png");
  const builtAssets = join(root, "dist", "assets");
  let path: string | null = existsSync(sourceAsset) ? sourceAsset : null;
  try {
    if (!path) {
      const file = readdirSync(builtAssets).find((name) => /^cover-fallback-[\w-]+\.png$/.test(name));
      if (file) path = join(builtAssets, file);
    }
  } catch {
    // The source asset is available in development before the first Vite build.
  }
  path ??= sourceAsset;
  let buffer: Buffer;
  try {
    buffer = readFileSync(path);
  } catch {
    throw new Error("运营占位图资源不存在，不能录入 VBK 草稿。");
  }
  if (buffer.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
    throw new Error("运营占位图不是有效 PNG，不能录入 VBK 草稿。");
  }
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (Math.max(width, height) < 1280 || Math.min(width, height) < 800 || buffer.length > 8 * 1024 * 1024) {
    throw new Error(`运营占位图尺寸或大小不符合上传要求（${width}×${height}，${buffer.length} 字节）。`);
  }
  return { name: PLACEHOLDER_COVER_FILE_NAME, mimeType: "image/png", buffer };
}
