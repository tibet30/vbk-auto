import { retryVbkRead } from "../../../infrastructure/vbk-read-retry.js";
import { vbkSessionRequest, type VbkSessionRequestBrowser } from "../../../infrastructure/vbk-session-request.js";
import { assertVbkAckSuccess } from "../../../infrastructure/vbk-response-error.js";

export async function getProductBaseInfoApi(page: VbkSessionRequestBrowser, productId: string): Promise<Record<string, any>> {
  const response = await retryVbkRead(() => vbkSessionRequest(page, {
    endpoint: "https://online.ctrip.com/restapi/soa2/15638/getProductBaseInfo",
    browserRequestTimeoutMs: 20_000, evaluateTimeoutMs: 25_000,
    errorLabel: "VBK 基本信息回读", headers: { cookieorigin: "https://vbooking.ctrip.com" },
    body: {
      contentType: "json", head: { cid: "", ctok: "", cver: "1.0", lang: "01", sid: "8888", syscode: "09", auth: "", extension: [] },
      productId,
      needAdvancedSettings: true,
      needBaseInfo: true,
      needBookingControls: true,
      needContractInfo: true,
      needMeta: true,
      needNameArea: true,
      need4135PackageInfo: true,
      needSaleControlInfo: true,
      needViewLink: true,
      needDistrictScenicSpots: true,
      needParentChildren: true,
    },
  }));
  return assertVbkAckSuccess(response.payload, "VBK 基本信息回读") as Record<string, any>;
}

