import assert from "node:assert/strict";
import test from "node:test";
import { runProductPreflightApi } from "../../src/main/automation/ctrip/preflight-api.ts";

const success = (payload: Record<string, unknown>) => ({
  status: 200,
  payload: { ResponseStatus: { Ack: "Success" }, ...payload },
  durationMs: 1,
  ctx: {},
});

test("母产品没有酒店或用车资源需求时，预检不读取交通子产品资源段", async () => {
  const endpoints: string[] = [];
  const page = {
    evaluate: async (_fn: unknown, request: any) => {
      const endpoint = String(request?.endpoint ?? "");
      endpoints.push(endpoint);
      if (endpoint.endsWith("/getProductBaseInfo")) {
        return success({
          baseInfo: {
            productId: 78490988,
            masterDepartureCityId: 28,
            destinationCityID: 28,
            vendorProductCode: "VBK-78490988",
          },
        });
      }
      if (endpoint.endsWith("/getPackageList")) {
        return success({
          itemList: [{ name: "成都2天1晚自由行", singleResourceId: 11, optionalResourceId: 22 }],
        });
      }
      if (endpoint.endsWith("/getdescriptionInfo")) {
        return success({
          info: {
            pmRcmdItems: [{}, {}, {}],
            productDesc: { productDesc: "成都亲子自由行" },
          },
        });
      }
      if (endpoint.endsWith("/getProductTourInfoList")) {
        return success({ tourInfos: [{ tourInfoId: 1001 }] });
      }
      if (endpoint.endsWith("/getTourDailyDetail.json")) {
        return success({ tourInfo: { tourDailyDescriptions: [{}, {}] } });
      }
      if (endpoint.endsWith("/listProductClauses")) {
        return success({ centralDataDto: { additionalInfoDto: {} } });
      }
      if (endpoint.endsWith("/GetBatchOperateSchedule")) {
        return success({ dates: [{ base: { productDate: "2026-09-15" } }] });
      }
      if (endpoint.endsWith("/getSegments")) {
        throw new Error("不应为交通子产品失败读取母产品资源段");
      }
      throw new Error(`unexpected endpoint ${endpoint}`);
    },
  };

  const result = await runProductPreflightApi(page, {
    basicInfo: { days: 2 },
    commercial: {
      packageName: "成都2天1晚自由行",
      pricing: { minimumTravelers: 1 },
      inventory: { startDate: "2026-09-15", endDate: "2026-09-15", dailyQuota: 10 },
    },
    operations: {
      hotelResource: { source: "nonPlatform" },
      transport: "none",
      vehicleResource: {},
    },
    itinerary: [
      { day: 1, hotel: "无" },
      { day: 2, hotel: "无" },
    ],
  }, "78490988");

  assert.equal(result.verifiedWith, "remote-api-readback");
  assert.equal(result.resources.segmentCount, 0);
  assert.equal(endpoints.some((endpoint) => endpoint.endsWith("/getSegments")), false);
});
