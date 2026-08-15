import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";

import { fillButlerContact } from "../../src/main/automation/ctrip/basic-info/sections.js";

test("管家联系人等待远端搜索结果替换空关键词第一页后再选择", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <div id="bookingControls.vendorBookingAssistant">
        <input role="combobox" aria-controls="butler-options" />
        <input class="ant-select-search__field" />
      </div>
      <div id="butler-options" class="ant-select-dropdown">
        <div class="ant-select-dropdown-menu-item">刘诗韵</div>
        <div class="ant-select-dropdown-menu-item">宋锦儿</div>
      </div>
      <script>
        window.chosen = "";
        const search = document.querySelector("input.ant-select-search__field");
        search.addEventListener("input", () => {
          setTimeout(() => {
            const dropdown = document.querySelector(".ant-select-dropdown");
            dropdown.innerHTML = [
              '<div class="ant-select-dropdown-menu-item">安思科-国际 ansike@qq.com</div>',
              '<div class="ant-select-dropdown-menu-item">安思科 ansike@qq.com</div>',
            ].join("");
            for (const option of dropdown.children) {
              option.addEventListener("click", () => { window.chosen = option.textContent; });
            }
          }, 700);
        });
      </script>
    `);

    await fillButlerContact(page, {
      contactCardId: 1368298,
      displayName: "安思科",
      providerId: 1279416,
    });

    assert.match(await page.evaluate(() => (window as any).chosen), /^安思科 /);
  } finally {
    await browser.close();
  }
});
