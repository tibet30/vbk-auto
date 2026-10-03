import { vbkSessionRequest, type VbkSessionRequestBrowser } from "../../../infrastructure/vbk-session-request.js";
import { responseHasBoundCover, responseHasBoundAttractionImage } from "./cover-bind.js";

/** 跨重启只复用仍在远端存在的图片，不用本地检查点替代远端事实。 */
export async function verifyPresentationImageCheckpoint(page: VbkSessionRequestBrowser, productId: number, checkpoint: unknown): Promise<boolean> {
  const saved = checkpoint as { imageId?: number; attractionImages?: Array<{ imageId?: number }> } | null;
  if (!saved?.imageId) return false;
  const result = await vbkSessionRequest(page, {
    endpoint: "https://online.ctrip.com/restapi/soa2/20698/searchProductImage.json",
    body: { productId }, errorLabel: "回读图文图片检查点",
    browserRequestTimeoutMs: 15_000, evaluateTimeoutMs: 20_000,
    includeCidQuery: true, headers: { cookieorigin: "https://vbooking.ctrip.com" },
    referrer: "https://vbooking.ctrip.com/", referrerPolicy: "strict-origin-when-cross-origin",
  });
  const ack = (result.payload as any)?.ResponseStatus?.Ack;
  if (ack && ack !== "Success") throw new Error(`图文图片检查点回读失败：Ack=${ack}`);
  return responseHasBoundCover(result.payload, saved.imageId)
    && (saved.attractionImages ?? []).every(image => Number.isInteger(image.imageId)
      && responseHasBoundAttractionImage(result.payload, image.imageId!));
}
