import { createRequire } from "node:module";
import { readCover } from "../operations/cover-info.js";
import {
  listManualCoverMeta,
  resolveManualCoverPath,
} from "../infrastructure/database/parts/cover-storage.js";

export interface ManualCoverAsset {
  path: string;
  width: number;
  height: number;
  fileId: string;
}

function electronApi(): typeof import("electron") {
  // Keep this module importable by Node-only contract tests; Electron is needed
  // only when checking an actual local file in the main process.
  return createRequire(import.meta.url)("electron") as typeof import("electron");
}

/** Check the saved local file before creating a remote draft or offering upload. */
export function inspectManualCoverAsset(
  product: Record<string, unknown>,
  dataPath?: string,
): { asset: ManualCoverAsset | null; issue: string | null } {
  const cover = readCover(product);
  if (cover?.source !== "manualUpload") return { asset: null, issue: null };
  const actualDataPath = dataPath ?? electronApi().app.getPath("userData");
  const raw = (product.presentation as { cover?: Record<string, unknown> }).cover ?? {};
  const originalName = typeof raw.originalName === "string" ? raw.originalName : "";
  const mimeType = typeof raw.mimeType === "string" ? raw.mimeType : "";
  const meta = listManualCoverMeta(actualDataPath).find((item) => item.fileId === cover.fileId);
  if (!meta || !originalName || meta.originalName !== originalName || meta.mimeType !== mimeType) {
    return { asset: null, issue: "手动封面的本地文件记录不完整，请重新上传原图。" };
  }
  if (mimeType !== "image/jpeg" && mimeType !== "image/png") {
    return { asset: null, issue: "携程图片上传仅接受 JPEG 或 PNG，请重新上传这两种格式的原图。" };
  }
  const filePath = resolveManualCoverPath({ dataPath: actualDataPath, fileId: cover.fileId!, originalName });
  if (!filePath) return { asset: null, issue: "手动封面的本地文件已失效，请重新上传原图。" };
  const image = electronApi().nativeImage.createFromPath(filePath);
  if (image.isEmpty()) return { asset: null, issue: "手动封面无法解码，请重新上传 JPEG 或 PNG 原图。" };
  const { width, height } = image.getSize();
  if (Math.max(width, height) < 1280 || Math.min(width, height) < 800) {
    return {
      asset: null,
      issue: `已保存手动封面（${width}×${height}），但携程封面要求至少 1280×800 或 800×1280 像素。请上传符合尺寸的原图。`,
    };
  }
  return { asset: { path: filePath, width, height, fileId: cover.fileId! }, issue: null };
}
