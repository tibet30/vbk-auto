/** Supplier bundle 9-e2a3dd: JSON base64 upload, followed by a separate cover binding. */
import { NonAdvisableAutomationError } from "../../automation.main/automation.main.errors.js";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { CoverUploadFile } from "./manual-cover-upload.js";
import { bindCtripLibraryCoverViaApi, readBoundCoverImageIdsViaApi } from "./cover-bind.js";
import { vbkSessionRequest, type VbkSessionRequestBrowser } from "../../../infrastructure/vbk-session-request.js";
import { assertVbkAckSuccess } from "../../../infrastructure/vbk-response-error.js";

type Client = VbkSessionRequestBrowser & { url(): string };
const MAX_BYTES = 8 * 1024 * 1024;

export async function readManualCoverBytes(file: CoverUploadFile) {
  const name = basename(typeof file === "string" ? file : file.name);
  const bytes = typeof file === "string" ? await readFile(file) : file.buffer;
  if (!name || !bytes.length || bytes.length > MAX_BYTES) {
    throw new Error("封面文件为空、缺少文件名或超过 8 MiB 上限。");
  }
  const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg = bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]));
  if (!png && !jpeg) throw new Error("封面上传仅支持 JPEG 或 PNG 原图。");
  return { name, bytes };
}

async function request(client: Client, path: string, body: object, label: string, upload = false) {
  const result = await vbkSessionRequest(client, {
    endpoint: `https://online.ctrip.com/restapi/soa2${path}`,
    body: { contentType: "json", head: { cid: "", ctok: "", cver: "1.0", lang: "01",
      sid: "8888", syscode: "09", auth: "", extension: [] }, ...body }, errorLabel: label,
    browserRequestTimeoutMs: upload ? 60_000 : 12_000,
    evaluateTimeoutMs: upload ? 65_000 : 15_000,
    headers: { cookieorigin: "https://vbooking.ctrip.com",
      "x-gate-request-source": "online", "x-tour-auth-from": "vbk_online" },
    referrer: upload
      ? `https://vbooking.ctrip.com/product/input/productImageText?productId=${(body as { productId: number }).productId}&pattern=4&from=vbk`
      : "https://vbooking.ctrip.com/",
    referrerPolicy: upload ? "no-referrer-when-downgrade" : "strict-origin-when-cross-origin",
  });
  try {
    return assertVbkAckSuccess(result.payload, label);
  } catch (error) {
    const extensions = (result.payload as { ResponseStatus?: { Extension?: Array<{ Id?: string; Value?: string }> } })?.ResponseStatus?.Extension;
    const info = extensions?.find(item => item.Id === "Info")?.Value;
    throw new Error(`${error instanceof Error ? error.message : String(error)}${info ? `：${String(info).slice(0, 300)}` : ""}`);
  }
}

export async function resolveManualCoverCity(client: Client, city: string) {
  const name = city.trim();
  if (!name) throw new Error("封面上传缺少产品城市。");
  const payload = await request(client, "/15638/suggestdistrict.json",
    { keyword: name, districtType: "CITY" }, "查询封面城市");
  const candidates = Array.isArray(payload.districtDtos) ? payload.districtDtos : [];
  const matches = candidates.filter((item: any) => item?.name === name
    && Number.isSafeInteger(item.id) && item.id > 0
    && Number.isSafeInteger(item.countryId) && item.countryId > 0);
  if (matches.length !== 1) throw new Error(`封面城市 ${name} 未返回唯一精确匹配，已停止上传。`);
  return matches[0] as { id: number; countryId: number };
}

/** No page acquisition and no automatic retry after an uncertain upload outcome. */
export async function uploadNewManualCoverViaApi(
  client: Client, productId: number, file: CoverUploadFile, city: string,
  onUploaded?: (imageId: number) => Promise<void> | void,
  beforeWrite?: () => Promise<void>,
): Promise<{ imageId: number; reused: boolean }> {
  if (!client.nativeOnly || !client.vbkSessionFetch) throw new Error("封面 API 上传需要原生账号会话。");
  if (!Number.isSafeInteger(productId) || productId <= 0) throw new Error("封面上传缺少合法产品 ID。");
  const { name, bytes } = await readManualCoverBytes(file);
  const district = await resolveManualCoverCity(client, city);
  await beforeWrite?.();
  let payload: Record<string, unknown>;
  try {
    payload = await request(client, "/20698/uploadImage.json", {
      productId,
      body: [{
        fileName: name, fileBytes: bytes.toString("base64"),
        tags: [
          { tagType: "District", tagValue: String(district.id) },
          { tagType: "PoiId", tagValue: "" },
          { tagType: "Country", tagValue: String(district.countryId) },
        ],
        expireDate: null, source: 1, imageClass: "TourProduct",
      }],
    }, "上传本地封面", true);
  } catch (error) {
    // A transport error can happen after the supplier has stored the image.
    throw new NonAdvisableAutomationError(`封面上传未确认，不自动重传；请先核查远端图片。${error instanceof Error ? error.message : String(error)}`);
  }
  const items = Array.isArray(payload.body) ? payload.body : [];
  const item = items.length === 1 ? items[0] : undefined;
  const imageId = Number(item?.imageId);
  if (item?.success !== true || !Number.isSafeInteger(imageId) || imageId <= 0) {
    throw new NonAdvisableAutomationError("封面上传未返回唯一成功图片 ID，已停止绑定；请核查远端图片后再继续。");
  }
  // Persist before binding. A later bind failure can resume with this image ID.
  try {
    await onUploaded?.(imageId);
  } catch {
    throw new NonAdvisableAutomationError(`图片已上传（imageId=${imageId}），但保存本地图片 ID 失败；已停止绑定，请勿重新上传。`);
  }
  try {
    await bindCtripLibraryCoverViaApi(client, imageId, productId, { beforeWrite });
  } catch (error) {
    if (!onUploaded) throw new NonAdvisableAutomationError(`图片已上传（imageId=${imageId}），但绑定未确认且无持久化回调；请复用此 ID 恢复。`);
    throw error;
  }
  const ids = await readBoundCoverImageIdsViaApi(client, productId);
  if (ids.length !== 1 || ids[0] !== imageId) {
    throw new Error(`图片已上传（imageId=${imageId}），但回读未确认唯一封面。`);
  }
  return { imageId, reused: false };
}
