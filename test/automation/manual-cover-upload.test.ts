import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { activeManualCoverDialog, activeManualCoverSection, selectManualCoverCity, submitManualCoverUpload, uploadedImageId } from "../../src/main/automation/ctrip/presentation/manual-cover-upload.js";

test("supplier upload must return exactly one successful image ID", () => {
  assert.equal(uploadedImageId({ body: [{ success: true, imageId: 44788490 }] }), 44788490);
  assert.equal(uploadedImageId({ body: [{ success: false, imageId: 44788490 }] }), null);
  assert.equal(uploadedImageId({ body: [{ success: true, imageId: 0 }] }), null);
  assert.equal(uploadedImageId({ body: [] }), null);
  assert.equal(uploadedImageId({ body: [
    { success: true, imageId: 1 }, { success: true, imageId: 2 },
  ] }), null);
});

test("manual cover ignores VBK's hidden skeleton upload dialog", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <div class="ant-modal uploadpic-modal" style="display:none">上传图片资源</div>
      <div class="ant-modal uploadpic-modal">上传图片资源<input id="District"></div>
    `);
    assert.equal(await activeManualCoverDialog(page).locator("#District").count(), 1);
  } finally {
    await browser.close();
  }
});

test("manual cover targets the active cover section, not the VBK skeleton", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <div id="lingjie-skeleton"><div class="image-category-container">
        <h3 class="image-category-title"><span class="required-asterisk">*</span>封面</h3>
        <span>旧界面</span></div></div>
      <div class="image-category-container"><h3 class="image-category-title">
        <span class="required-asterisk">*</span>封面</h3><span>当前界面</span></div>
    `);
    assert.match(await activeManualCoverSection(page).innerText(), /当前界面/);
  } finally {
    await browser.close();
  }
});

test("manual cover completes VBK's second head-image confirmation", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <div role="dialog"><button id="submit">同意并上传</button></div>
      <div class="ant-popover ant-popconfirm" style="display:none">
        当前图片将作为产品头图 <button id="confirm">确 定</button></div>
      <script>
        document.querySelector('#submit').onclick = () => {
          document.querySelector('.ant-popover').style.display = 'block';
        };
        document.querySelector('#confirm').onclick = () => {
          document.querySelector('#confirm').dataset.done = 'yes';
        };
      </script>
    `);
    await submitManualCoverUpload(page, page.getByRole("dialog"));
    assert.equal(await page.locator("#confirm").getAttribute("data-done"), "yes");
  } finally {
    await browser.close();
  }
});

test("manual cover selects the product city without requiring a scenic POI", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <div role="dialog"><div class="ant-select"><input id="District">
        <span class="ant-select-selection-item"></span></div></div>
      <div class="ant-select-dropdown"><div class="ant-select-item-option">
        <span class="Name" title="泸州">泸州</span></div></div>
      <script>
        document.querySelector('.ant-select-item-option').onclick = () => {
          document.querySelector('.ant-select-selection-item').textContent = '泸州';
        };
      </script>
    `);
    const dialog = page.getByRole("dialog");
    await selectManualCoverCity(page, dialog, "泸州");
    assert.equal(await dialog.locator(".ant-select-selection-item").textContent(), "泸州");
    assert.equal(await dialog.locator("#PoiId").count(), 0);
  } finally {
    await browser.close();
  }
});
