import test from "node:test";
import assert from "node:assert/strict";
import { getProductBaseInfoSaveModel } from "../../src/main/automation/ctrip/basic-info/save-model.js";

function client(base: unknown = { baseInfo: { productId: 79234080 }, clause: { id: 12 }, resourceFields: { hotel: true } }, agencies: unknown = [{ localInfoId: 3 }]) {
  const calls: any[] = [];
  return {
    calls, nativeOnly: true,
    evaluate: async () => { throw new Error("页面已关闭"); },
    vbkSessionGetText: async () => { throw new Error("不应读取 HTML"); },
    vbkSessionFetch: async (request: any) => {
      calls.push(request);
      const data = request.endpoint.endsWith("getProductBaseInfo") ? base : { localInfoDtos: agencies };
      return { status: 200, payload: { ResponseStatus: { Ack: "Success" }, ...(data as object) }, durationMs: 1, ctx: {} as any };
    },
  };
}

test("基本信息已有保存数据时只读取数据接口，不打开页面", async () => {
  const page = client();
  assert.deepEqual(await getProductBaseInfoSaveModel(page, "79234080"), {
    baseInfo: { productId: 79234080 }, clause: { id: 12 }, resourceFields: { hotel: true }, localInfoDtos: [{ localInfoId: 3 }],
  });
  assert.deepEqual(page.calls.map(call => call.endpoint.split("/").at(-1)), ["getProductBaseInfo", "getProviderLocalInfo"]);
  assert.equal(page.calls[1].body.idType, "product");
  assert.equal(page.calls[1].body.id, "79234080");
});

test("复用已读取的远端模型，避免重复请求基本信息", async () => {
  const page = client();
  const result = await getProductBaseInfoSaveModel(page, "79234080", { baseInfo: { productId: 79234080 } });
  assert.deepEqual(result.resourceFields, {});
  assert.equal(page.calls.length, 1);
  assert.match(page.calls[0].endpoint, /getProviderLocalInfo$/);
});

test("保存模型或地接社响应缺失时阻断，不降级到 HTML", async () => {
  await assert.rejects(getProductBaseInfoSaveModel(client({}), "79234080"), /缺少 baseInfo/);
  await assert.rejects(getProductBaseInfoSaveModel(client(undefined, null), "79234080"), /缺少 localInfoDtos/);
});
