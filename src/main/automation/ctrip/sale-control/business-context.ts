import { PRODUCT_FORM_LABELS, type ProductForm } from "../../../../shared/product-form.js";
import { vbkSessionRequest, type VbkSessionRequestBrowser, type VbkSessionNativeRequest } from "../../../infrastructure/vbk-session-request.js";
import { assertVbkAckSuccess } from "../../../infrastructure/vbk-response-error.js";

/** Resolve the signed business, without changing persistent login/browser cookies. */
export async function resolveCreateBusinessContext(
  page: VbkSessionRequestBrowser, vendorId: number, form: ProductForm,
): Promise<NonNullable<VbkSessionNativeRequest["businessContext"]>> {
  const response = await vbkSessionRequest(page, {
    endpoint: "https://online.ctrip.com/restapi/soa2/14894/getProviderBusinessLineList",
    body: { providerId: vendorId }, headers: { "x-tour-auth-from": "vbk_online" },
    errorLabel: "VBK 已签约业务线查询", browserRequestTimeoutMs: 20_000, evaluateTimeoutMs: 25_000,
  });
  const payload = assertVbkAckSuccess(response.payload, "VBK 已签约业务线查询");
  if (Number(payload.providerId) !== vendorId) throw new Error("VBK 业务线供应商与当前账号不一致");
  const name = form === "semiSelfGuided" ? "跟团游" : PRODUCT_FORM_LABELS[form];
  const lines = Array.isArray(payload.providerBusinessLineList) ? payload.providerBusinessLineList : [];
  const matches = lines.filter(line => line?.businessLineName === name && line.statusEnum === "signed");
  if (matches.length !== 1) throw new Error(`VBK 产品形态「${name}」缺少唯一已签约业务线`);
  const businessId = Number(matches[0].cooperateBusinessLine);
  const travelType = Number(matches[0].travelType ?? 0);
  if (!Number.isInteger(businessId) || businessId <= 0 || !Number.isInteger(travelType) || travelType < 0) {
    throw new Error("VBK 已签约业务线返回无效上下文");
  }
  return { businessId, travelType };
}
