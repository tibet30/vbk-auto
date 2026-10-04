import { vbkSessionRequest, type VbkSessionRequestBrowser } from "../../../infrastructure/vbk-session-request.js";
import { assertVbkAckSuccess } from "../../../infrastructure/vbk-response-error.js";
import { getProductBaseInfoApi } from "./read-base.js";
import { readDefaultBookingContacts, REQUIRED_BOOKING_CONTACT_IDS } from "./default-contacts.js";

/** The platform's base-info and local-agency APIs replace editor HTML parsing. */
export async function getProductBaseInfoSaveModel(
  page: VbkSessionRequestBrowser, productId: string, remote?: Record<string, any>,
): Promise<Record<string, any>> {
  const model = remote ?? await getProductBaseInfoApi(page, productId);
  if (!model.baseInfo || typeof model.baseInfo !== "object" || Array.isArray(model.baseInfo)) {
    throw new Error("VBK 基本信息接口缺少 baseInfo 保存模型");
  }
  const response = await vbkSessionRequest(page, {
    endpoint: "https://online.ctrip.com/restapi/soa2/15638/getProviderLocalInfo",
    browserRequestTimeoutMs: 20_000, evaluateTimeoutMs: 25_000,
    errorLabel: "VBK 地接社候选读取", headers: { cookieorigin: "https://vbooking.ctrip.com" },
    body: { contentType: "json", id: productId, idType: "product",
      head: { cid: "", ctok: "", cver: "1.0", lang: "01", sid: "8888", syscode: "09", auth: "", extension: [] } },
  });
  const agencies = assertVbkAckSuccess(response.payload, "VBK 地接社候选读取") as Record<string, any>;
  if (!Array.isArray(agencies.localInfoDtos)) throw new Error("VBK 地接社接口缺少 localInfoDtos 候选列表");
  const { ResponseStatus: _status, ...fields } = model;
  const booking = model.bookingControls ?? model.bookingControl;
  let bookingControls = booking;
  if (booking && REQUIRED_BOOKING_CONTACT_IDS.some(key => Number(booking[key]) <= 0 || !booking[key])) {
    const defaults = await readDefaultBookingContacts(page, productId, Number(model.baseInfo.vendorId));
    bookingControls = { ...booking };
    for (const key of REQUIRED_BOOKING_CONTACT_IDS) {
      if (!(Number(booking[key]) > 0)) bookingControls[key] = defaults[key];
    }
  }
  return { ...fields, ...(bookingControls ? { bookingControls } : {}),
    resourceFields: model.resourceFields ?? {}, localInfoDtos: agencies.localInfoDtos };
}
