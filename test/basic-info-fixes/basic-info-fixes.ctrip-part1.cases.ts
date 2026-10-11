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
import { fillScenicAreaProvince } from "../../src/main/automation/ctrip/basic-info/scenic.js";
import {
  clickLocatorSnapshotOption,
  getControlledDropdownOptions,
  readLocatorSnapshot,
} from "../../src/main/automation/ctrip/utils.js";

test("fillScenicAreaProvince 识别中国山西标签并幂等跳过", async () => {
  const source = readCtripSource();
  const start = source.indexOf("async function fillScenicAreaProvince");
  const end = source.indexOf("\nasync function fillServicePhone", start);
  const body = source.slice(start, end);
  assert.match(body, /container\.locator\("\.ant-tag"\)\.allTextContents\(\)/);
  assert.match(body, /text\.includes\(provinceBase\)/);
  assert.match(body, /return;/);
  assert.match(body, /comboboxes\.nth\(1\)\.click\(\)/,
    "国家景区省份必须直接操作第二级下拉");
  assert.match(body, /pickSearchInput\(comboboxes\.nth\(1\), "省份搜索输入框"\)/,
    "省份搜索框必须来自第二级下拉");
  assert.doesNotMatch(body, /comboboxes\.nth\(0\)/,
    "国家保持空白，禁止操作第一级国家下拉");
  assert.match(body, /DIRECT_ADMIN_MUNICIPALITIES\.has\(provinceBase\)/,
    "直辖市不应强制等待 VBK 不提供的省份候选");
  assert.match(body, /provinceSearch\.fill\(label\)/,
    "省份远程搜索应一次写入完整关键词");
  assert.doesNotMatch(body, /provinceSearch\.type\(/,
    "省份远程搜索禁止逐字触发并发请求");
});

test("pickSearchInput 从 combobox 外层返回内部唯一可编辑输入框，也支持直接 input", async () => {
  const { pickSearchInput } = await import("../../src/main/automation/ctrip/utils.js");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <div id="province-box" role="combobox"><input class="ant-select-search__field" /><input id="decoy" /></div>
      <input id="direct" />
      <div id="ambiguous" role="combobox"><input /><input /></div>
      <div id="ambiguous-preferred" role="combobox"><input class="ant-select-search__field" /><input class="ant-select-search__field" /></div>
      <div id="hidden-only" role="combobox"><input style="display:none" /></div>
    `);
    const nested = await pickSearchInput(page.locator("#province-box"), "省份");
    assert.equal(await nested.getAttribute("class"), "ant-select-search__field");
    await nested.fill("山西");
    assert.equal(await page.locator("#province-box .ant-select-search__field").inputValue(), "山西");
    assert.equal(await page.locator("#decoy").inputValue(), "", "普通输入框不得抢占优先搜索框");
    const direct = await pickSearchInput(page.locator("#direct"), "直接输入");
    await direct.fill("可直接写入");
    assert.equal(await page.locator("#direct").inputValue(), "可直接写入");
    await assert.rejects(() => pickSearchInput(page.locator("#ambiguous"), "省份"), /期望 1 个可编辑输入框，实际 2/);
    await assert.rejects(() => pickSearchInput(page.locator("#ambiguous-preferred"), "省份"), /期望 1 个可编辑输入框，实际 2/);
    await assert.rejects(() => pickSearchInput(page.locator("#hidden-only"), "省份"), /期望 1 个可编辑输入框，实际 0/);
  } finally {
    await browser.close();
  }
});

test("国家景区省份实际只操作第二级，国家保持留空后成功添加省份", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <style>.ant-select-dropdown-hidden { display: none; }</style>
      <div id="scenic_area">
        <div id="country" role="combobox"><input class="ant-select-search__field" placeholder="国家" /></div>
        <div id="province" role="combobox" aria-controls="province-options"><input class="ant-select-search__field" placeholder="省份" /></div>
        <div id="city" role="combobox"><input class="ant-select-search__field" placeholder="城市/景区" /></div>
        <div id="spot" role="combobox"><input class="ant-select-search__field" placeholder="景点" /></div>
        <button type="button">添加</button>
      </div>
      <div id="province-options" class="ant-select-dropdown ant-select-dropdown-hidden">
        <div class="ant-select-item-option">山西省</div>
      </div>
      <script>
        window.scenicEvents = [];
        const dropdown = document.querySelector('.ant-select-dropdown');
        document.querySelectorAll('#scenic_area [role="combobox"]').forEach((combobox) => {
          combobox.addEventListener('click', () => window.scenicEvents.push('click:' + combobox.id));
          const input = combobox.querySelector('input');
          input.addEventListener('input', () => window.scenicEvents.push('input:' + combobox.id + ':' + input.value));
        });
        document.querySelector('#province').addEventListener('click', () => dropdown.classList.remove('ant-select-dropdown-hidden'));
        document.querySelector('.ant-select-item-option').addEventListener('click', () => {
          window.scenicEvents.push('choose:山西省');
          dropdown.classList.add('ant-select-dropdown-hidden');
        });
        document.querySelector('#scenic_area button').addEventListener('click', () => {
          window.scenicEvents.push('add');
          const tag = document.createElement('span');
          tag.className = 'ant-tag';
          tag.textContent = '山西省';
          document.querySelector('#scenic_area').append(tag);
        });
      </script>
    `);

    await fillScenicAreaProvince(page, "山西");

    const events = await page.evaluate(() => window.scenicEvents);
    assert.ok(events.includes("click:province"), "必须点击第二级省份下拉");
    assert.ok(events.includes("input:province:山西"), "必须在第二级输入省份名称");
    assert.ok(events.includes("choose:山西省"), "必须选择精确省份候选");
    assert.ok(events.includes("add"), "选择省份后必须点击添加");
    assert.ok(!events.some((event) => event.includes("country")), "禁止操作国家级下拉");
    assert.equal(await page.locator("#country input").inputValue(), "", "国家级必须保持留空");
    assert.equal(await page.locator("#scenic_area .ant-tag").innerText(), "山西省");
  } finally {
    await browser.close();
  }
});

test("fillAdvanceBooking 通过时间面板提交受控时间值", async () => {
  const source = readCtripSource();
  const start = source.indexOf("async function fillAdvanceBooking");
  const end = source.indexOf("\nasync function fillLocalTravelAgency", start);
  const body = source.slice(start, end);
  assert.match(body, /\.ant-time-picker-panel:visible/);
  assert.match(body, /\.ant-time-picker-panel-select/);
  assert.match(body, /committed !== time/);
  assert.doesNotMatch(body, /timeInput\.fill\(/, "受控时间组件不能再用 fill 直接赋值");
});

test("fillButlerContact 不再使用 scope.count() ? scope : page 的歧义写法", async () => {
  const source = readCtripSource();
  const start = source.indexOf("async function fillButlerContact");
  assert.ok(start >= 0, "找不到 fillButlerContact 定义");
  // 仅校验本函数体，避免误伤同文件其它位置。
  const rest = source.slice(start);
  const end = rest.indexOf("\nasync function ", 1);
  const body = end >= 0 ? rest.slice(0, end) : rest;
  assert.ok(
    !/scope\.count\(\)\s*\?\s*scope\s*:\s*page/.test(body),
    "fillButlerContact 仍包含 scope.count() ? scope : page；count() 返回 Promise 永远 truthy，会回退到整页定位",
  );
});

test("fillButlerContact 用稳定的 div[id=bookingControls.vendorBookingAssistant] 并兼容预订联系人 label 定位", async () => {
  const source = readCtripSource();
  const start = source.indexOf("async function findBookingContactScope");
  assert.ok(start >= 0, "找不到 findBookingContactScope 定义");
  const rest = source.slice(start);
  const end = rest.indexOf("\nasync function ", 1);
  const body = end >= 0 ? rest.slice(0, end) : rest;
  assert.ok(
    /div\[id="bookingControls\.vendorBookingAssistant"\]/.test(body),
    "findBookingContactScope 必须优先用 div[id=bookingControls.vendorBookingAssistant] 收敛范围",
  );
  assert.match(body, /预订联系人\|预定联系人/, "页面仅保留中文 label 时必须能定位预订联系人");
});

test("fillButlerContact 不在容器内使用 first() 逃避歧义", async () => {
  const source = readCtripSource();
  const start = source.indexOf("async function fillButlerContact");
  assert.ok(start >= 0, "找不到 fillButlerContact 定义");
  const rest = source.slice(start);
  const end = rest.indexOf("\nasync function ", 1);
  const body = end >= 0 ? rest.slice(0, end) : rest;
  // scope 拿到之后，到搜索输入框 assertCount 结束之前：容器内的 combobox 与
  // input 必须由 assertCount 兜底唯一，不允许用 .first() 偷懒。
  const scopeMatch = body.match(/(?:const|let)\s+(?:\{\s*)?scope\b[^\n;]*;/);
  assert.ok(scopeMatch, "找不到 scope = ... 赋值");
  const searchAnchor = body.indexOf("await assertCount(search, 1");
  assert.ok(searchAnchor > 0, "找不到搜索输入框 assertCount 调用");
  const scopedRegion = body.slice(scopeMatch.index, searchAnchor);
  assert.ok(
    !/\.first\(\)/.test(scopedRegion),
    "fillButlerContact 在容器内仍出现 .first()，违反唯一性契约",
  );
});

test("pickKeySpotsFromItinerary 从 spots[].name 按行程顺序去重且不限制数量", () => {
  const product = productFixture({
    itinerary: [
      { day: 1, title: "第一天", spots: [{ name: "晋祠博物馆" }, { name: "  晋祠博物馆  " }, { name: "平遥古城" }] },
      { day: 2, title: "第二天", spots: [{ name: "平遥古城" }, { name: "云冈石窟" }, { name: "壶口瀑布" }] },
      { day: 3, title: "第三天", spots: [{ name: "五台山" }] },
    ],
  });
  assert.deepEqual(pickKeySpotsFromItinerary(product), [
    "晋祠博物馆",
    "平遥古城",
    "云冈石窟",
    "壶口瀑布",
    "五台山",
  ]);
});

test("pickKeySpotsFromItinerary 不受推荐语排序影响", () => {
  const product = productFixture({
    itinerary: [
      { day: 1, title: "第一天", spots: [{ name: "柳巷" }, { name: "食品街" }, { name: "汾河公园" }] },
      { day: 2, title: "第二天", spots: [{ name: "晋祠" }, { name: "山西博物院" }] },
    ],
    presentation: {
      recommendation: "晋祠三绝、山西博物院晋魂展",
      features: "三大核心文化 IP",
    },
  });
  assert.deepEqual(pickKeySpotsFromItinerary(product), [
    "柳巷",
    "食品街",
    "汾河公园",
    "晋祠",
    "山西博物院",
  ]);
});

test("pickKeySpotsFromItinerary 跳过空值、无效项与历史字符串", () => {
  const product = productFixture({
    itinerary: [
      { day: 1, title: "第一天", spots: [null, 0, "旧字符串", {}, { name: "" }, { name: 3 }, { name: "晋祠" }] },
      { day: 2, title: "第二天", spots: "非数组" },
    ],
  } as unknown as Record<string, unknown>);
  assert.deepEqual(pickKeySpotsFromItinerary(product), ["晋祠"]);
});

test("pickKeySpotsFromItinerary 大小写不敏感去重", () => {
  const product = productFixture({
    itinerary: [
      { day: 1, title: "第一天", spots: [{ name: "MaoMing" }, { name: "maoming" }] },
    ],
  });
  assert.deepEqual(pickKeySpotsFromItinerary(product), ["MaoMing"]);
});

test("pickKeySpotsFromItinerary 优先 poiName（贴近 VBK 内部标签名）", () => {
  const product = productFixture({
    itinerary: [
      { day: 1, title: "第一天", spots: [
        { name: "西安明城墙", poiName: "西安城墙", poiId: 75686 },
        { name: "兵马俑博物馆", poiName: "秦始皇帝陵博物院(兵马俑)", poiId: 75682 },
        { name: "仅 name，无 poiName", poiName: null },
      ] },
    ],
  });
  assert.deepEqual(pickKeySpotsFromItinerary(product), [
    "西安城墙",
    "秦始皇帝陵博物院(兵马俑)",
    "仅 name，无 poiName",
  ]);
});

test("全量录入和单阶段 basic 重试共用带回读的 basic API handler", async () => {
  const read = (file: string) => fs.readFile(new URL(`../../src/main/automation/automation.main/${file}`, import.meta.url), "utf8");
  for (const entry of ["automation.main.run.ts", "automation.main.run-one.ts"]) {
    const runner = await read(entry);
    assert.match(runner, /buildBasicExecute\(ctx/);
    assert.doesNotMatch(runner, /fillAndSaveBasicInfo\(/);
  }
  const basic = await read("runtime/basic.ts");
  assert.match(basic, /await ensureBasicInfoApi\(/);
  assert.match(basic, /await saveBasicInfo\([\s\S]*setBasicInfoSaved\(/);
});
