import {
  assert,
  basicInfoCompletenessIssues,
  findButlerOptionIndex,
  findFirstEnabledOptionIndex,
  findProvinceOptionIndex,
  fs,
  helperBody,
  isProductImageTextUrl,
  parseProduct,
  pickCityOption,
  pickKeySpotsFromItinerary,
  productFixture,
  PRODUCT_IMAGE_TEXT_PATH,
  readAutomationSource,
  readCtripSource,
  resolveAdvanceBooking,
  shouldRefillBasicInfo,
  stripComments,
  test,
} from "./basic-info-fixes.shared.js";
import { chromium } from "playwright";
import { fillScenicAreaSpots } from "../../src/main/automation/ctrip/basic-info/scenic.js";
import { fillServicePhone } from "../../src/main/automation/ctrip/basic-info/sections.js";

test("fillScenicAreaSpots 已提交 choice 命中后跳过（part2 主链路锁定）", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <style>.ant-select-dropdown-hidden { display: none; }</style>
      <div id="scenic_area">
        <span class="ant-select-selection__choice" title="西安城墙（西安/陕西/中国）">
          <span class="ant-select-selection__choice__content">西安城墙（西安/陕西/中国）</span>
          <span class="ant-select-selection__choice__remove">×</span>
        </span>
        <div id="country" role="combobox">
          <span class="ant-select-selection-item" title="中国">中国</span>
          <input class="ant-select-search__field" placeholder="国家" />
        </div>
        <div id="province" role="combobox">
          <span class="ant-select-selection-item" title="陕西">陕西</span>
          <input class="ant-select-search__field" placeholder="省份" />
        </div>
        <div id="city" role="combobox">
          <span class="ant-select-selection-item" title="西安">西安</span>
          <input class="ant-select-search__field" placeholder="城市/景区" />
        </div>
        <div id="spot" role="combobox">
          <span class="ant-select-selection-item" title="西安明城墙">西安明城墙</span>
          <input class="ant-select-search__field" placeholder="景点" />
        </div>
        <button type="button" id="add">添加</button>
      </div>
      <div class="ant-select-dropdown ant-select-dropdown-hidden">
        <div class="ant-select-item-option">西安城墙</div>
      </div>
      <script>
        window.scenicEvents = [];
        document.querySelectorAll('#scenic_area [role="combobox"]').forEach((box) => {
          box.addEventListener('click', () => window.scenicEvents.push('click:' + box.id));
          box.querySelector('input').addEventListener('input', () => window.scenicEvents.push('input:' + box.id));
        });
        document.querySelector('#add').addEventListener('click', () => window.scenicEvents.push('add'));
      </script>
    `);
    const logs: string[] = [];
    await fillScenicAreaSpots(page, "陕西", ["西安城墙"], logs);
    const events = await page.evaluate(() => (window as any).scenicEvents as string[]);
    assert.ok(!events.some((event) => event.startsWith("click:")), "不得触发 combobox 点击");
    assert.ok(!events.some((event) => event.startsWith("input:")), "不得触发 combobox 搜索输入");
    assert.ok(!events.includes("add"), "不得点击添加按钮");
    assert.ok(logs.some((log) => log.includes("西安城墙") && log.includes("已存在")), "logs 必须包含已存在提示");
  } finally {
    await browser.close();
  }
});

import "./basic-info-fixes.ctrip-part2.cases.js";
