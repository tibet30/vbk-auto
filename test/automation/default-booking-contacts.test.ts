import test from "node:test";
import assert from "node:assert/strict";
import { getProductBaseInfoSaveModel } from "../../src/main/automation/ctrip/basic-info/save-model.js";

const defaults = { vendorComplainContactId: 11, vendorBookingContactId: 12, vendorBookingEmergencyContactId: 13 };
function client(booking: Record<string, number>, identity = { productId: 42, vendorId: 7 }, contacts = defaults) {
  let reads = 0;
  return {
    nativeOnly: true, reads: () => reads,
    evaluate: async () => { throw new Error("禁止打开页面"); },
    vbkSessionFetch: async () => ({ status: 200, payload: { ResponseStatus: { Ack: "Success" }, localInfoDtos: [] }, durationMs: 1, ctx: {} as any }),
    vbkSessionGetText: async (request: any) => {
      reads++;
      assert.match(request.endpoint, /baseInfoMerge\?productid=42&from=vbk$/);
      return { status: 200, text: `window.__INITIAL_STATE__ = ${JSON.stringify({ productBaseInfo: { baseInfo: identity, bookingControls: contacts } })}\n</script>` };
    },
    model: { baseInfo: { productId: 42, vendorId: 7 }, bookingControls: booking },
  };
}

test("缺失默认联系人从后台服务端模型补齐，并保留已有联系人", async () => {
  const page = client({ ...defaults, vendorComplainContactId: 99, vendorBookingContactId: 0 });
  const saved = await getProductBaseInfoSaveModel(page as any, "42", page.model);
  assert.deepEqual(saved.bookingControls, { ...defaults, vendorComplainContactId: 99 });
  assert.equal(page.reads(), 1);
  assert.equal(page.model.bookingControls.vendorBookingContactId, 0);
});

test("已有完整联系人不读取服务端页面模型", async () => {
  const page = client(defaults);
  await getProductBaseInfoSaveModel(page as any, "42", page.model);
  assert.equal(page.reads(), 0);
});

test("产品或供应商不匹配及联系人缺失时阻断保存模型", async () => {
  for (const identity of [{ productId: 43, vendorId: 7 }, { productId: 42, vendorId: 8 }]) {
    const page = client({}, identity);
    await assert.rejects(getProductBaseInfoSaveModel(page as any, "42", page.model), /不一致/);
  }
  const page = client({}, undefined, { ...defaults, vendorComplainContactId: 0 });
  await assert.rejects(getProductBaseInfoSaveModel(page as any, "42", page.model), /未配置默认联系人/);
});
