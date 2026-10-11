import type { Page } from "playwright";
import { vbkSessionRequest } from "../../infrastructure/vbk-session-request.js";
import { assertPlatformQueryResponse } from '../../infrastructure/platform-query-response.js';

export async function searchVbkResources(page: Page) {
  const response = await vbkSessionRequest(page, {
    endpoint: "https://online.ctrip.com/restapi/soa2/15638/searchResourceList.json",
    browserRequestTimeoutMs: 12_000,
    evaluateTimeoutMs: 15_000,
    errorLabel: "VBK 资源列表查询",
    body: {
      contentType: "json",
      head: { cid: "", ctok: "", cver: "1.0", lang: "01", sid: "8888", syscode: "09", auth: "", xsid: "", extension: [] },
      resourceIds: [], resourceName: "", departureCityId: null, destinationCityId: null, productRegion: null,
      active: "T", vendorId: null, pmEid: "", paEid: "", createTimeStart: null, createTimeEnd: null,
      forProductCategory: [], forProductPattern: [], forSaleMode: [], pageNo: 1, pageSize: 100,
      vendorResourceCodes: [], businessOwner: "CUSTOM",
    },
  });
  assertPlatformQueryResponse(response.payload, [['resources']], 'VBK 酒店资源查询');
  return response.payload;
}
