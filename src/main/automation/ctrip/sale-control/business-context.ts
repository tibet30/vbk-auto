import { PRODUCT_FORM_LABELS, type ProductForm } from "../../../../shared/product-form.js";
import { vbkSessionRequest, type VbkSessionRequestBrowser, type VbkSessionNativeRequest } from "../../../infrastructure/vbk-session-request.js";
import { assertVbkAckSuccess } from "../../../infrastructure/vbk-response-error.js";

/**
 * VBK「业务线」与「产品形态」不是同名一对一，取同名会漏掉没有独立业务线的形态：
 *   - 自由行没有独立业务线，产品形态挂在「定制游」业务线下；
 *   - 半自助游挂在「跟团游」业务线下。
 * 线上账号的已签约业务线只有定制游/跟团游/私家团/景点玩乐，直接按形态名查会让
 * 自由行在写入第一步（销售控制）必然失败。
 */
const FORM_BUSINESS_LINE: Record<ProductForm, string> = {
  privateTour: "私家团",
  groupTour: "跟团游",
  semiSelfGuided: "跟团游",
  freeTravel: "定制游",
};

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
  const lines = Array.isArray(payload.providerBusinessLineList) ? payload.providerBusinessLineList : [];
  const signed = lines.filter(line => line?.statusEnum === "signed");
  const lineName = FORM_BUSINESS_LINE[form];
  const matches = signed.filter(line => line?.businessLineName === lineName);
  if (matches.length !== 1) {
    const available = signed.map(line => String(line?.businessLineName ?? "").trim()).filter(Boolean);
    throw new Error(`VBK 产品形态「${PRODUCT_FORM_LABELS[form]}」缺少唯一已签约业务线`
      + `（应为「${lineName}」；当前已签约：${available.join("、") || "无"}）`);
  }
  const businessId = Number(matches[0].cooperateBusinessLine);
  const travelType = Number(matches[0].travelType ?? 0);
  if (!Number.isInteger(businessId) || businessId <= 0 || !Number.isInteger(travelType) || travelType < 0) {
    throw new Error("VBK 已签约业务线返回无效上下文");
  }
  return { businessId, travelType };
}
