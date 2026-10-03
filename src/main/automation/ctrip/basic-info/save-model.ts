import type { VbkSessionRequestBrowser } from "../../../infrastructure/vbk-session-request.js";

/** Read the editor model through the account session, independently of visible-page navigation. */
export async function getProductBaseInfoSaveModel(page: VbkSessionRequestBrowser, productId: string) {
  const endpoint = `https://vbooking.ctrip.com/ivbk/vendor/baseInfoMerge?productId=${encodeURIComponent(productId)}&from=vbk`;
  const headers = { accept: "text/html,application/xhtml+xml,*/*;q=0.8" };
  const response = page.vbkSessionGetText
    ? await page.vbkSessionGetText({ endpoint, headers, errorLabel: "VBK 基本信息保存模型读取" })
    : await page.evaluate(async ({ endpoint, headers }) => {
      const result = await fetch(endpoint, { method: "GET", credentials: "include", headers });
      return { status: result.status, text: await result.text() };
    }, { endpoint, headers });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`VBK 基本信息保存模型读取失败：HTTP ${response.status}`);
  }
  const match = response.text.match(/window\.__INITIAL_STATE__\s*=\s*(.*)/);
  if (!match) throw new Error("VBK 基本信息页面缺少 __INITIAL_STATE__");
  let state: Record<string, any>;
  try { state = JSON.parse(match[1]); } catch { throw new Error("VBK 基本信息保存模型 JSON 无效"); }
  const model = state?.productBaseInfo;
  if (!model || typeof model !== "object" || Array.isArray(model)) {
    throw new Error("VBK 基本信息页面缺少 productBaseInfo 保存模型");
  }
  return { ...model, resourceFields: state?.resourceFields ?? {}, localInfoDtos: state?.localInfoDtos ?? [] };
}
