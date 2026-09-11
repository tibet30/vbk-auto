import test from "node:test";
import assert from "node:assert/strict";
import { ensurePackageApi } from "../../src/main/automation/ctrip/package-api.js";

function executablePage(cookie: string, fetchImpl: typeof fetch) {
  return {
    async evaluate<T, A>(fn: (arg: A) => T | Promise<T>, arg: A) {
      const previousDocument = (globalThis as { document?: unknown }).document;
      const previousFetch = globalThis.fetch;
      (globalThis as { document?: { cookie: string } }).document = { cookie };
      globalThis.fetch = fetchImpl;
      try {
        return await fn(arg);
      } finally {
        if (previousDocument === undefined) delete (globalThis as { document?: unknown }).document;
        else (globalThis as { document?: unknown }).document = previousDocument;
        globalThis.fetch = previousFetch;
      }
    },
  };
}

function jsonResponse(payload: unknown) {
  return new Response(JSON.stringify(payload), { status: 200 });
}

test("ensurePackageApi 创建首套餐后轮询到物化资源再保存正式套餐", async () => {
  const requests: Array<{ path: string; body: any; headers: Record<string, string> }> = [];
  let packageListReads = 0;
  const product = {
    sales: { productForm: "privateTour", splitGroup: false },
    basicInfo: {
      supplierProductCode: "VBK-CODE-001",
      subtitle: "日喀则人文深度游",
      days: 2,
      nights: 1,
      meetingCity: "日喀则",
    },
    presentation: { recommendation: "帕拉庄园与扎什伦布寺串联。" },
    commercial: { packageName: "日喀则2天1晚私家团·当地4钻" },
    itinerary: [{ hotel: "当地4钻酒店" }, { hotel: "无" }],
  };
  const page = executablePage("GUID=CID-VALUE", async (url, init) => {
    const path = new URL(String(url)).pathname.split("/").pop() ?? "";
    const body = JSON.parse(String(init?.body ?? "{}"));
    requests.push({ path, body, headers: init?.headers as Record<string, string> });
    if (path === "getPackageList") {
      packageListReads += 1;
      if (packageListReads < 3) {
        return jsonResponse({ ResponseStatus: { Ack: "Success", Errors: [] }, itemList: [] });
      }
      return jsonResponse({
        ResponseStatus: { Ack: "Success", Errors: [] },
        itemList: [{
          name: "日喀则2天1晚私家团·当地4钻",
          vendorResourceCode: "VBK-CODE-001",
          confirmHour: 4,
          isHotelResource: "T",
          priceInputType: 1,
          resourceNameRule: { days: 2 },
          singleResourceId: 11,
          optionalResourceId: 22,
        }],
      });
    }
    if (path === "getProductBaseInfo") {
      return jsonResponse({ ResponseStatus: { Ack: "Success", Errors: [] }, baseInfo: { vendorId: 38289 } });
    }
    if (path === "saveCustomerCpntTemplateInfo") {
      return jsonResponse({ ResponseStatus: { Ack: "Success", Errors: [] }, cpntTemplateInfoId: 5122001 });
    }
    if (path === "savePackageItem") {
      return jsonResponse({ ResponseStatus: { Ack: "Success", Errors: [] } });
    }
    throw new Error(`unexpected path ${path}`);
  });

  const result = await ensurePackageApi(page, product, "78350550", { pause: async () => {} });

  assert.deepEqual(result, {
    packageName: "日喀则2天1晚私家团·当地4钻",
    savedWith: "tour-helper-api",
    verified: true,
    days: 2,
  });
  assert.equal(packageListReads, 4);
  const createRequest = requests.filter((request) => request.path === "savePackageItem")[0];
  assert.equal(createRequest.headers.cookieorigin, "https://vbooking.ctrip.com");
  assert.equal(createRequest.body.head.cid, "CID-VALUE");
  assert.equal(createRequest.body.packageInfo.name, "日喀则2天1晚私家团·当地4钻");
  assert.equal(createRequest.body.packageInfo.isHotelResource, "T");
});
