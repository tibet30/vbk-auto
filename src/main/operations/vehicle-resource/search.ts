/**
 * VBK 资源库 searchResourceGroup 接口调用：
 *   - searchVehicleResourceGroups：page 上 fetch /restapi/soa2/15638/searchResourceGroup，
 *     参数 resourceGroupName（座位+车型），按 cid 拼 x-traceID，返回解析后的安全 payload；
 *   - 非 2xx / 非 JSON 都明确抛错。
 */

import type { Page } from "playwright";
import { vbkSessionRequest } from "../../infrastructure/vbk-session-request.js";

export async function searchVehicleResourceGroups(page: Page, query: string) {
  const response = await vbkSessionRequest(page, {
    endpoint: "https://online.ctrip.com/restapi/soa2/15638/searchResourceGroup",
    browserRequestTimeoutMs: 12_000,
    evaluateTimeoutMs: 15_000,
    errorLabel: "VBK 资源组搜索",
    body: {
      contentType: "json",
      head: {
        cid: "",
        ctok: "",
        cver: "1.0",
        lang: "01",
        sid: "8888",
        syscode: "09",
        auth: "",
        xsid: "",
        extension: [],
      },
      resourceGroupName: query,
      pageNo: 1,
      pageSize: 10,
    },
  });
  return response.payload;
}