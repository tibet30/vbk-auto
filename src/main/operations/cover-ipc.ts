/**
 * 封面信息 IPC handler 集合：
 *   - cover:uploadManual     接收 renderer 上传的字节 → 落本地副本 → 返回 meta
 *   - cover:read             读取手动上传图片后编码成 data URL；
 *                            字段 url 即「可直接 <img src>」的 data: URL，
 *                            文件丢失时返回 url=null + meta。
 *                            **不再**返回 file:// 路径，避免 Electron / 沙盒 /
 *                            路径编码下 file:// 不稳定造成破图。
 *   - cover:listManualCovers 列出所有现存手动上传 meta（调试 / UI 辅助）
 *   - cover:searchCtripLibraryPlaces
 *                            阶段 A：keyword → suggestpoi.json → 地址 / 景点
 *                            候选列表；UI 在地址列表里选中一个后再调下条。
 *   - cover:searchCtripLibraryImages
 *                            阶段 B：已选 place { poiId, ... } → searchImage
 *                            → getImageInfo → image candidates；选中候选
 *                            写回 product.presentation.cover。
 *
 * 设计原则：
 *  - 每个 handler 入口都先 assertTrustedSender，避免外部 frame 触发；
 *  - 手动上传走 cover-storage 校验（mime / size / 空文件）；
 *  - 携程图库查询先确认 VBK 已登录；keyword / place 由 renderer 提供并校验；
 *  - searchCtripLibraryPlaces / searchCtripLibraryImages 走
 *    ctrip-library-search 的 searchCtripLibraryPlaces /
 *    searchCtripLibraryImagesForPlace 直接 BrowserView fetch；
 *  - **预览传输**：manualUpload 预览改走 data URL（main 端读本地副本 → base64 →
 *    data:${mime};base64,...），持久化仍只存 fileId/meta，绝不写入图片字节；
 *    data URL 仅在 IPC 响应里临时返回，不缓存到任何产品 JSON；
 *  - 错误信息保持中文、可观察；不写半成品状态。
 */
import fs from "node:fs/promises";
import { app, type IpcMainInvokeEvent } from "electron";
import type {
  CtripLibraryPlaceSearchResult,
  CtripLibrarySearchResult,
  ManualUploadCoverMeta,
} from "../../shared/contracts-types.js";
import { assertTrustedSender } from "../infrastructure/ipc-sender.js";
import {
  MANUAL_UPLOAD_MIME_TYPES,
  storeManualCoverFile,
  resolveManualCoverPath,
  listManualCoverMeta,
  readManualCoverDataUrl,
} from "../infrastructure/database/parts/cover-storage.js";
import type { VbkBrowser } from "../infrastructure/vbk-browser.js";
import type { PoiSuggestBrowser } from "../infrastructure/poi-suggest.js";
import {
  searchCtripLibraryImagesForPlace,
  searchCtripLibraryPlaces,
} from "../infrastructure/ctrip-library-search.js";
import { createConsoleCoverPlaceLogger } from "../infrastructure/cover-place-search-logger.js";

type BrowserLike = Pick<VbkBrowser, "status" | "evaluate"> & PoiSuggestBrowser;

interface UploadArgs {
  originalName: string;
  mimeType: string;
  /** base64 编码的字节；不允许直接传 Uint8Array 跨 IPC。 */
  base64: string;
}

interface SearchCtripLibraryArgs {
  keyword: string;
}

interface SearchCtripLibraryImagesArgs {
  keyword: string;
  place: { poiId: number; poiName: string } | null;
}

function dataPath(): string {
  return app.getPath("userData");
}

/**
 * 手动上传封面：
 *  1. assertTrustedSender；
 *  2. 解析 args（originalName / mimeType / base64）；
 *  3. 走 cover-storage.storeManualCoverFile 校验 + 落盘；
 *  4. 返回 ManualUploadCoverMeta；不写 product（写 product 由 projects:updateReviewField 完成）。
 *
 * 注意：base64 解码后的字节由 storeManualCoverFile 校验 mime / size / 空文件。
 */
export async function uploadManualCover(
  event: IpcMainInvokeEvent,
  args: UploadArgs,
): Promise<ManualUploadCoverMeta> {
  assertTrustedSender(event, "cover:uploadManual");
  if (!args || typeof args !== "object") {
    throw new Error("上传封面参数不合法。");
  }
  const originalName = typeof args.originalName === "string" ? args.originalName : "";
  const mimeType = typeof args.mimeType === "string" ? args.mimeType : "";
  const base64 = typeof args.base64 === "string" ? args.base64 : "";
  if (!base64) throw new Error("上传封面失败：缺少图片数据。");
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(Buffer.from(base64, "base64"));
  } catch {
    throw new Error("上传封面失败：图片数据无法解析。");
  }
  return storeManualCoverFile({
    dataPath: dataPath(),
    originalName,
    mimeType,
    bytes,
  });
}

/**
 * cover:read IPC handler：把手动上传图片读成 data URL 返回给 renderer。
 *  - 旧实现返回 file:// URL，Electron + 沙盒 + 路径编码下经常破图；
 *  - 新实现：main 端 fs.readFile → base64 → data:${mime};base64,...
 *    URL 字段名保持 url 以兼容 renderer 已有调用；
 *  - 文件丢失或解码失败 → url=null + 持久化 meta（如果有），UI 走
 *    「图片已失效，请重新上传」分支；
 *  - data URL 仅在 IPC 响应里返回，不入 product JSON；renderer 端只用来
 *    喂 <img src>，不要持久化到 state / draft / setNotice 等位置。
 *
 * 真正的 IO 逻辑在 cover-storage.readManualCoverDataUrl，本文件只做
 * assertTrustedSender + 参数校验 + 转发，方便单元测试绕过 electron。
 */
export async function readManualCover(
  event: IpcMainInvokeEvent,
  args: { fileId: string; originalName: string },
): Promise<{ url: string | null; mimeType: string | null; sizeBytes: number | null; uploadedAt: string | null; originalName: string | null }> {
  assertTrustedSender(event, "cover:read");
  if (!args || typeof args !== "object") throw new Error("读取封面参数不合法。");
  const fileId = typeof args.fileId === "string" ? args.fileId.trim() : "";
  const originalName = typeof args.originalName === "string" ? args.originalName : "";
  if (!fileId) throw new Error("读取封面失败：缺少 fileId。");
  return readManualCoverDataUrl({ dataPath: dataPath(), fileId, originalName });
}

/**
 * 列出现存所有手动上传 meta（仅元数据，不含图片二进制）。
 * 调试 / UI「我的上传」面板用；不在主流程里强制依赖。
 */
export function listManualCoverMetas(event: IpcMainInvokeEvent): { supportedMimeTypes: readonly string[]; records: ManualUploadCoverMeta[] } {
  assertTrustedSender(event, "cover:listManualCovers");
  return {
    supportedMimeTypes: MANUAL_UPLOAD_MIME_TYPES,
    records: listManualCoverMeta(dataPath()),
  };
}

/**
 * 携程图库封面查询（cover:searchCtripLibraryPlaces，阶段 A）：
 *  1. assertTrustedSender；
 *  2. 校验 keyword 非空；
 *  3. 必须 VBK 已登录（status.loggedIn === true）；
 *  4. 调 searchCtripLibraryPlaces 走 suggestPoi 直接链路；UI 拿到的是地址 /
 *     景点候选列表（poiId + poiName + 可选 address / province / city /
 *     district），不再返回 image candidates；
 *  5. 该函数不再依赖任何 DOM 弹窗 / 模态弹层 / DOM 抓取；
 *  6. logger 在主进程侧注入 console.warn 桥接，保证 search-start /
 *     suggest.success/failure 等事件能真实打 console，便于运营排查。
 */
export async function searchCtripLibraryCoverPlaces(
  event: IpcMainInvokeEvent,
  args: SearchCtripLibraryArgs,
  browser: BrowserLike,
): Promise<CtripLibraryPlaceSearchResult> {
  assertTrustedSender(event, "cover:searchCtripLibraryPlaces");
  const keyword = typeof args?.keyword === "string" ? args.keyword.trim() : "";
  if (!keyword) {
    throw new Error("查询携程图库必须提供景点关键词。");
  }
  const status = await browser.status(false);
  if (!status.loggedIn) {
    throw new Error("查询携程图库失败：未登录 VBK，请先在右侧浏览器登录。");
  }
  const searchLogger = createConsoleCoverPlaceLogger({ prefix: COVER_SEARCH_LOG_PREFIX_PLACES });
  return searchCtripLibraryPlaces(browser, keyword, { logger: searchLogger });
}

/**
 * 携程图库封面查询（cover:searchCtripLibraryImages，阶段 B）：
 *  1. assertTrustedSender；
 *  2. 校验 keyword 非空 + place 含 poiId（正整数）+ poiName（非空）；
 *  3. 必须 VBK 已登录（status.loggedIn === true）；
 *  4. 调 searchCtripLibraryImagesForPlace 走 searchImage → getImageInfo
 *     直接链路，返回 image candidates；UI 选中后写回 product；
 *  5. logger 在主进程侧注入 console.warn 桥接；
 *  6. 业务失败 / 未登录 / place 不合法时直接抛错。
 */
export async function searchCtripLibraryCoverImages(
  event: IpcMainInvokeEvent,
  args: SearchCtripLibraryImagesArgs,
  browser: BrowserLike,
): Promise<CtripLibrarySearchResult> {
  assertTrustedSender(event, "cover:searchCtripLibraryImages");
  const keyword = typeof args?.keyword === "string" ? args.keyword.trim() : "";
  if (!keyword) {
    throw new Error("查询携程图库必须提供景点关键词。");
  }
  const place = args?.place;
  const placePoiId = place && typeof place === "object" && Number.isInteger((place as { poiId?: unknown }).poiId) && ((place as { poiId: number }).poiId) > 0
    ? (place as { poiId: number }).poiId
    : null;
  const placePoiName = place && typeof place === "object" && typeof (place as { poiName?: unknown }).poiName === "string"
    ? (place as { poiName: string }).poiName.trim()
    : "";
  if (placePoiId === null || !placePoiName) {
    throw new Error("查询携程图库必须提供已选地址（poiId + poiName）。");
  }
  const status = await browser.status(false);
  if (!status.loggedIn) {
    throw new Error("查询携程图库失败：未登录 VBK，请先在右侧浏览器登录。");
  }
  const searchLogger = createConsoleCoverPlaceLogger({ prefix: COVER_SEARCH_LOG_PREFIX_IMAGES });
  return searchCtripLibraryImagesForPlace(
    browser,
    { keyword, place: { poiId: placePoiId, poiName: placePoiName } },
    { logger: searchLogger },
  );
}

/** 日志前缀与 cover-place-search-logger 的 COVER_SEARCH_LOG_PREFIX 保持同步；
 *  inline 字符串以避免 cover-ipc 与 cover-place-search-logger 之间形成循环依赖。
 *  阶段 A / B 分别带不同前缀，便于在日志里区分调用路径。
 */
const COVER_SEARCH_LOG_PREFIX_PLACES = "[cover.searchCtripLibraryPlaces]";
const COVER_SEARCH_LOG_PREFIX_IMAGES = "[cover.searchCtripLibraryImages]";

/**
 * 同步保留 IPC helper（renderer 偶尔需要知道本地副本是否还存在）。
 * 不写入产品 JSON；只在 UI 上用作「图片已失效，请重新上传」判断。
 */
export async function isManualCoverStillPresent(
  event: IpcMainInvokeEvent,
  args: { fileId: string; originalName: string },
): Promise<boolean> {
  assertTrustedSender(event, "cover:exists");
  if (!args || typeof args !== "object") return false;
  const fileId = typeof args.fileId === "string" ? args.fileId.trim() : "";
  const originalName = typeof args.originalName === "string" ? args.originalName : "";
  if (!fileId) return false;
  const absolute = resolveManualCoverPath({ dataPath: dataPath(), fileId, originalName });
  if (!absolute) return false;
  try {
    await fs.access(absolute);
    return true;
  } catch {
    return false;
  }
}