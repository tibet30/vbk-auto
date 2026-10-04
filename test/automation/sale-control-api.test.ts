import assert from "node:assert/strict";
import test from "node:test";
import { loadSaleControlCreateState } from "../../src/main/automation/ctrip/sale-control/api.js";

function client(state: any = { vendorId: 1279416, contractDtos: [], regionDistributionChannelDtos: [] }) {
  const calls: any[] = [];
  return {
    calls, nativeOnly: true,
    evaluate: async () => { throw new Error("页面已关闭"); },
    vbkSessionGetText: async () => { throw new Error("不应读取 HTML"); },
    vbkSessionFetch: async (request: any) => {
      calls.push(request);
      const data = request.endpoint.endsWith("getCurrentUserInfo") ? { user: { providerId: 1279416 } } : state;
      return { status: 200, payload: { ResponseStatus: { Ack: "Success" }, ...data }, durationMs: 1, ctx: {} as any };
    },
  };
}

test("销售控制创建配置由当前账号与数据接口读取，不依赖 HTML", async () => {
  const page = client();
  const state = await loadSaleControlCreateState(page);
  assert.equal(state.vendorId, 1279416);
  assert.deepEqual(page.calls.map(call => call.endpoint.split("/").at(-1)), ["getCurrentUserInfo", "getSaleControlInfo"]);
  assert.equal(page.calls[1].body.id, 1279416);
  assert.equal(page.calls[1].body.idType, "providerId");
});

test("销售控制配置缺失或与当前账号不一致时停止创建", async () => {
  await assert.rejects(loadSaleControlCreateState(client({ vendorId: 7 })), /当前账号供应商不一致/);
  await assert.rejects(loadSaleControlCreateState(client({ vendorId: 1279416 })), /缺少合同或分销区域配置/);
});

test("产品壳创建返回 ID 后先回调保存，再执行可能失败的回读", async () => {
  const { configureProductShellApi } = await import("../../src/main/automation/ctrip/sale-control/api.js");
  const order: string[] = [];
  const page = {
    nativeOnly: true,
    vbkSessionFetch: async (request: any) => {
      const endpoint = request.endpoint.split("/").at(-1);
      order.push(endpoint);
      const data: Record<string, any> = {
        getCurrentUserInfo: { user: { providerId: 1279416 } },
        getSaleControlInfo: {
          vendorId: 1279416,
          contractDtos: [{ contractId: 5097849,
            categoryDtos: [{ productCategoryName: "境内短途旅游", productCategoryId: 9 }],
            patternDtos: [{ productPatternName: "私家团", productPatternId: 4 }],
          }],
          regionDistributionChannelDtos: [{ region: "CN", distributionChannels: [{ channelName: "ctrip", childChannels: [] },
            { channelName: "merchants", childChannels: [{ channelName: "merchant1" }] },
            { channelName: "tripsystem", childChannels: [] },
            { channelName: "offsitestream", childChannels: [] },
            { channelName: "ctripcustomchannel", childChannels: [] }] }],
        },
        getGlobalProductBrandList: { productBrandDtos: [{ brandId: 42, brandName: "测试" }] },
        getProviderBusinessLineList: { providerId: 1279416, providerBusinessLineList: [
          { cooperateBusinessLine: 6, businessLineName: "定制游", statusEnum: "signed" },
          { cooperateBusinessLine: 1, businessLineName: "私家团", statusEnum: "signed", travelType: 1 },
        ] },
        saveSaleControlInfo: { productId: 76543212 },
      };
      if (endpoint === "saveSaleControlInfo") {
        assert.equal(request.body.id, "1279416");
        assert.deepEqual(request.businessContext, { businessId: 1, travelType: 1 });
        assert.equal(request.body.saleControlInfoDto.maintainType, "P");
        assert.deepEqual(request.body.saleControlInfoDto.distributionChannels, ["ctrip", "merchants", "tripsystem"]);
      }
      if (endpoint === "getProductBaseInfo") throw new Error("回读失败");
      return { status: 200, payload: { ResponseStatus: { Ack: "Success" }, ...data[endpoint] }, durationMs: 1, ctx: {} as any };
    },
  };
  await assert.rejects(configureProductShellApi(page as any, { sales: { productType: "domesticShort", productForm: "privateTour" } }, id => {
    assert.equal(id, "76543212");
    order.push("persist-id");
  }), /回读失败/);
  assert.deepEqual(order.slice(-3), ["saveSaleControlInfo", "persist-id", "getProductBaseInfo"]);
});

test("未签约或供应商不一致的业务线在创建之前停止", async () => {
  const { resolveCreateBusinessContext } = await import("../../src/main/automation/ctrip/sale-control/business-context.js");
  const page = client({ providerId: 1279416, providerBusinessLineList: [
    { cooperateBusinessLine: 1, businessLineName: "私家团", statusEnum: "noSign", travelType: 1 },
  ] });
  await assert.rejects(resolveCreateBusinessContext(page, 1279416, "privateTour"), /缺少唯一已签约业务线/);
  await assert.rejects(resolveCreateBusinessContext(client({ providerId: 7 }), 1279416, "privateTour"), /供应商与当前账号不一致/);
  assert.equal(page.calls.some(call => call.endpoint.endsWith("saveSaleControlInfo")), false);
});
