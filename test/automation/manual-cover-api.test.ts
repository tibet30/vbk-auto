import { NonAdvisableAutomationError } from "../../src/main/automation/automation.main/automation.main.errors.js";
import test from "node:test";
import assert from "node:assert/strict";
import { uploadNewManualCoverViaApi } from "../../src/main/automation/ctrip/presentation/manual-cover-api.js";
import { uploadManualCoverViaSupplierPage } from "../../src/main/automation/ctrip/presentation/manual-cover-upload.js";
import { EMPTY_VBK_SESSION_CONTEXT } from "../../src/main/infrastructure/vbk-session-request.js";

const file = { name: "封面.png", mimeType: "image/png" as const,
  buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5V8AAAAASUVORK5CYII=", "base64") };
function fixture(options: { upload?: unknown; failBind?: boolean; cities?: unknown[]; extraCover?: boolean; transportError?: boolean } = {}) {
  const calls: string[] = [];
  const writes: any[] = [];
  let bound = false;
  const client = {
    nativeOnly: true, url: () => "about:blank",
    async evaluate(): Promise<never> { throw new Error("unexpected page execution"); },
    async acquireInteractivePage(): Promise<never> { throw new Error("unexpected page acquisition"); },
    async vbkSessionFetch(req: any) {
      const endpoint = new URL(req.endpoint).pathname.split("/").at(-1)!;
      calls.push(endpoint);
      let payload: any = { ResponseStatus: { Ack: "Success" } };
      if (endpoint === "suggestdistrict.json") payload.districtDtos = options.cities ?? [{ name: "泸州", id: 604, countryId: 1 }];
      if (endpoint === "uploadImage.json") {
        assert.equal(req.headers["x-gate-request-source"], "online");
        assert.equal(req.headers["x-tour-auth-from"], "vbk_online");
        assert.equal(req.referrer, "https://vbooking.ctrip.com/product/input/productImageText?productId=42&pattern=4&from=vbk");
        assert.equal(req.referrerPolicy, "no-referrer-when-downgrade");
        writes.push(req.body);
        if (options.transportError) throw new Error("connection lost");
        payload = options.upload ?? { ...payload, body: [{ success: true, imageId: 123 }] };
      }
      if (endpoint === "bindProductImage.json") {
        writes.push(req.body);
        payload.success = !options.failBind;
        bound = !options.failBind;
      }
      if (endpoint === "searchProductImage.json") payload.productImages = bound
        ? [123, ...(options.extraCover ? [456] : [])].map(imageId => ({ imageInfo: {
          imageId, fileName: file.name, accompanyTourInfo: { imageTypeId: 2 },
        } })) : [];
      return { status: 200, durationMs: 1, ctx: { ...EMPTY_VBK_SESSION_CONTEXT }, payload };
    },
  };
  return { client, calls, writes };
}

test("native first upload uses base64 JSON and persists ID before binding without a page", async () => {
  const f = fixture();
  let saved = 0;
  let gates = 0;
  const result = await uploadManualCoverViaSupplierPage(f.client, 42, file, "泸州", undefined,
    id => { saved = id; assert.equal(f.calls.includes("bindProductImage.json"), false); },
    async () => { gates++; });
  assert.deepEqual(result, { imageId: 123, reused: false });
  assert.equal(saved, 123);
  assert.equal(gates, 2);
  assert.equal(f.writes[0].head.sid, "8888");
  assert.deepEqual(f.writes[0], { contentType: "json", head: { cid: "", ctok: "", cver: "1.0", lang: "01", sid: "8888", syscode: "09", auth: "", extension: [] }, productId: 42, body: [{
    fileName: file.name, fileBytes: file.buffer.toString("base64"),
    tags: [{ tagType: "District", tagValue: "604" }, { tagType: "PoiId", tagValue: "" }, { tagType: "Country", tagValue: "1" }],
    expireDate: null, source: 1, imageClass: "TourProduct",
  }] });
  assert.equal(f.writes[1].isCover, true);
});

test("missing or ambiguous city, invalid image and cancellation cause no upload", async () => {
  for (const cities of [[], [{ name: "泸州市", id: 604, countryId: 1 }],
    [1, 2].map(id => ({ name: "泸州", id, countryId: 1 }))]) {
    const f = fixture({ cities });
    await assert.rejects(uploadNewManualCoverViaApi(f.client, 42, file, "泸州"), /唯一精确匹配/);
    assert.equal(f.writes.length, 0);
  }
  const f = fixture();
  await assert.rejects(uploadNewManualCoverViaApi(f.client, 42, { ...file, buffer: Buffer.from("bad") }, "泸州"), /JPEG/);
  await assert.rejects(uploadNewManualCoverViaApi(f.client, 42, file, "泸州", undefined, async () => { throw new Error("cancelled"); }), /cancelled/);
  assert.equal(f.writes.length, 0);
});

test("HTTP business failures, ambiguous responses and uncertain transport never bind or retry", async () => {
  for (const upload of [
    { ResponseStatus: { Ack: "Warning" }, body: [{ success: true, imageId: 123 }] },
    { ResponseStatus: { Ack: "Success" }, body: [{ success: false, imageId: 123 }] },
    { ResponseStatus: { Ack: "Success" }, body: [{ success: true, imageId: 0 }] },
    { ResponseStatus: { Ack: "Success" }, body: [{ success: true, imageId: 123 }, { success: true, imageId: 124 }] },
  ]) {
    const f = fixture({ upload });
    await assert.rejects(uploadNewManualCoverViaApi(f.client, 42, file, "泸州"));
    assert.equal(f.writes.length, 1);
  }
  const f = fixture({ transportError: true });
  await assert.rejects(uploadNewManualCoverViaApi(f.client, 42, file, "泸州"), NonAdvisableAutomationError);
  assert.equal(f.writes.length, 1);
});

test("bind failure preserves checkpoint and resume binds without another upload", async () => {
  const options = { failBind: true };
  const f = fixture(options);
  let saved = 0;
  await assert.rejects(uploadNewManualCoverViaApi(f.client, 42, file, "泸州", id => { saved = id; }), /success=true/);
  assert.equal(saved, 123);
  options.failBind = false;
  const result = await uploadManualCoverViaSupplierPage(f.client, 42, file, "泸州", saved);
  assert.equal(result.reused, true);
  assert.equal(f.calls.filter(x => x === "uploadImage.json").length, 1);
});

test("checkpoint persistence failure prevents bind; multiple covers never report success", async () => {
  const f = fixture();
  await assert.rejects(uploadNewManualCoverViaApi(f.client, 42, file, "泸州", () => { throw new Error("disk failure"); }), /保存本地图片 ID 失败/);
  assert.equal(f.writes.length, 1);
  const duplicate = fixture({ extraCover: true });
  await assert.rejects(uploadNewManualCoverViaApi(duplicate.client, 42, file, "泸州"), /唯一封面/);
});

test("供应商 Extension Info 业务错误会显示给用户", async () => {
  const f = fixture({ upload: { ResponseStatus: { Ack: "Warning", Extension: [{ Id: "Info", Value: "用户信息获取异常" }] } } });
  await assert.rejects(uploadNewManualCoverViaApi(f.client, 42, file, "泸州"), /用户信息获取异常/);
});
