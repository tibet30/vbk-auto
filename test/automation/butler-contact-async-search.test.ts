// @ts-nocheck
/** 「管家联系人」异步搜索契约：等待远端搜索结果替换空关键词首屏后再选择；
 *  「预订联系人」使用管家联系人信息直接录入。两组都用同一份共享的 headless chromium，
 *  page 通过 helper 拿取，避免每个用例独立 `chromium.launch` 在完整 e2e 套件里超过 60s 上限。 */
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { chromium, type Browser, type Page } from "playwright";

import { fillButlerContact } from "../../src/main/automation/ctrip/basic-info/sections.js";

let browser: Browser;

before(async () => {
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  await browser?.close();
});

async function newPage(html: string): Promise<Page> {
  const page = await browser.newPage();
  await page.setContent(html);
  return page;
}

test("管家联系人等待远端搜索结果替换空关键词第一页后再选择", async () => {
  const page = await newPage(`
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
  try {
    await fillButlerContact(page, {
      contactCardId: 1368298,
      displayName: "安思科",
      providerId: 1279416,
    });

    assert.match(await page.evaluate(() => (window as any).chosen), /^安思科 /);
  } finally {
    await page.close();
  }
});

test("预订联系人使用管家联系人信息录入", async () => {
  const page = await newPage(`
      <div class="ant-form-item">
        <label>预订联系人</label>
        <input role="combobox" aria-controls="booking-contact-options" />
        <input class="ant-select-search__field" />
      </div>
      <div id="booking-contact-options" class="ant-select-dropdown">
        <div class="ant-select-dropdown-menu-item" data-value="1753732">张三 zhangsan@qq.com</div>
        <div class="ant-select-dropdown-menu-item" data-value="1753733">李四 lisi@qq.com</div>
      </div>
      <script>
        window.chosen = "";
        for (const option of document.querySelectorAll(".ant-select-dropdown-menu-item")) {
          option.addEventListener("click", () => { window.chosen = option.textContent; });
        }
      </script>
    `);
  try {
    await fillButlerContact(page, {
      contactCardId: 1753732,
      displayName: "张三",
      providerId: 1279416,
    });

    assert.match(await page.evaluate(() => (window as any).chosen), /^张三 /);
  } finally {
    await page.close();
  }
});