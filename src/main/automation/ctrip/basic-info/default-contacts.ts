import type { VbkSessionRequestBrowser } from "../../../infrastructure/vbk-session-request.js";

export const REQUIRED_BOOKING_CONTACT_IDS = [
  "vendorComplainContactId", "vendorBookingContactId", "vendorBookingEmergencyContactId",
] as const;

/** The platform adds provider defaults to its server model, not to getProductBaseInfo. */
export async function readDefaultBookingContacts(
  page: VbkSessionRequestBrowser, productId: string, vendorId: number,
): Promise<Record<string, number>> {
  if (!page.vbkSessionGetText) throw new Error("VBK 缺少后台默认联系人读取客户端");
  const response = await page.vbkSessionGetText({
    endpoint: `https://vbooking.ctrip.com/ivbk/vendor/baseInfoMerge?productid=${encodeURIComponent(productId)}&from=vbk`,
    headers: { accept: "text/html,application/xhtml+xml,*/*;q=0.8" },
    errorLabel: "VBK 默认联系人读取",
  });
  if (response.status < 200 || response.status >= 300) throw new Error(`VBK 默认联系人读取失败：HTTP ${response.status}`);
  const match = response.text.match(/window\.__INITIAL_STATE__\s*=\s*(.*)/);
  if (!match) throw new Error("VBK 服务端模型缺少默认联系人数据");
  let model: any;
  try { model = JSON.parse(match[1])?.productBaseInfo; } catch { throw new Error("VBK 默认联系人模型 JSON 无效"); }
  if (String(model?.baseInfo?.productId) !== productId || Number(model?.baseInfo?.vendorId) !== vendorId) {
    throw new Error("VBK 默认联系人模型与当前产品或供应商不一致");
  }
  const booking = model?.bookingControls;
  const result: Record<string, number> = {};
  for (const key of REQUIRED_BOOKING_CONTACT_IDS) {
    const id = Number(booking?.[key]);
    if (!Number.isInteger(id) || id <= 0) throw new Error(`VBK 未配置默认联系人：${key}`);
    result[key] = id;
  }
  return result;
}
