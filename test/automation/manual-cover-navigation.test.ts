import test from "node:test";
import assert from "node:assert/strict";
import { prepareManualCoverUpload, uploadManualCoverViaSupplierPage } from "../../src/main/automation/ctrip/presentation/manual-cover-upload.js";
import { EMPTY_VBK_SESSION_CONTEXT } from "../../src/main/infrastructure/vbk-session-request.js";

test("复用远端已上传封面与拒绝非法新图片均不获取页面", async () => {
  let existing = true;
  let acquired = 0;
  const client = {
    nativeOnly: true,
    async evaluate() { throw new Error("不应执行页面脚本"); },
    async vbkSessionFetch() {
      return { status: 200, durationMs: 1, ctx: { ...EMPTY_VBK_SESSION_CONTEXT },
        payload: { productImages: existing ? [{ imageInfo: {
          imageId: 123, fileName: "cover.png", accompanyTourInfo: { imageTypeId: 2 },
        } }] : [] } };
    },
    async acquireInteractivePage() { acquired++; throw new Error("抵达新图片上传边界"); },
  };
  const file = { name: "cover.png", mimeType: "image/png" as const, buffer: Buffer.from("image") };
  assert.deepEqual(await uploadManualCoverViaSupplierPage(client, 79232466, file, "泸州"), { imageId: 123, reused: true });
  assert.equal(acquired, 0);
  existing = false;
  await assert.rejects(uploadManualCoverViaSupplierPage(client, 79232466, file, "泸州"), /JPEG 或 PNG/);
  assert.equal(acquired, 0);
});

function supplierPage(failures: Error[], license = true) {
  const events: string[] = [];
  let attempts = 0;
  const locator = (selector: string): any => ({
    first() { return this; }, filter() { return this; },
    locator, getByText: locator,
    async waitFor() {}, async fill() {},
    async isVisible() { return true; }, async hover() {},
    async count() { return selector === "替换封面" ? 0 : 1; },
    async innerText() { return "*封面"; },
    async isChecked() { return license; },
    async click() {
      if (selector === ".uploadpic-modal-addpic") events.push("open-chooser");
    },
    async evaluate() {
      if (selector === "#imageType") return "封面";
      if (selector === "#District") return "泸州";
      if (selector === ".uploadpic-modal-addpic") events.push("open-chooser");
    },
  });
  return {
    events,
    page: {
      locator,
      async goto(url: string) { assert.match(url, /productId=79232466/); attempts++; events.push("navigate"); },
      async waitForEvent(event: string) {
        assert.equal(event, "filechooser");
        events.push("acquire-chooser");
        const attempt = attempts;
        return { async setFiles(file: unknown) {
          assert.deepEqual(file, { name: "cover.png", mimeType: "image/png", buffer: Buffer.from("image") });
          events.push(`set-files:${attempt}`);
          if (failures[attempt - 1]) throw failures[attempt - 1];
        } };
      },
    },
  };
}
const file = { name: "cover.png", mimeType: "image/png" as const, buffer: Buffer.from("image") };
const navigation = new Error("fileChooser.setFiles: Execution context was destroyed, most likely because of a navigation");

test("封面文件选择器因跳转失效时重新进入原产品、重新授权并获取新选择器", async () => {
  const { page, events } = supplierPage([navigation]);
  await prepareManualCoverUpload(page, 79232466, file, "泸州", async () => { events.push("authorize"); });
  assert.deepEqual(events, [
    "navigate", "authorize", "acquire-chooser", "open-chooser", "set-files:1",
    "navigate", "authorize", "acquire-chooser", "open-chooser", "set-files:2",
  ]);
});

test("连续跳转只恢复一次，不无限重试", async () => {
  const { page, events } = supplierPage([navigation, navigation]);
  await assert.rejects(prepareManualCoverUpload(page, 79232466, file, "泸州"), /Execution context was destroyed/);
  assert.equal(events.filter(event => event === "navigate").length, 2);
});

test("文件错误、取消授权及缺少图片许可直接停止，不恢复上传", async () => {
  const invalid = supplierPage([new Error("file not found")]);
  await assert.rejects(prepareManualCoverUpload(invalid.page, 79232466, file, "泸州"), /file not found/);
  assert.equal(invalid.events.filter(event => event === "navigate").length, 1);
  const cancelled = supplierPage([]);
  await assert.rejects(prepareManualCoverUpload(cancelled.page, 79232466, file, "泸州", async () => {
    throw new Error("cancelled");
  }), /cancelled/);
  assert.equal(cancelled.events.includes("acquire-chooser"), false);
  const unlicensed = supplierPage([], false);
  await assert.rejects(prepareManualCoverUpload(unlicensed.page, 79232466, file, "泸州"), /授权协议尚未确认/);
  assert.equal(unlicensed.events.includes("acquire-chooser"), false);
});
