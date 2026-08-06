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

test("fillCitySelect 等待完整远程结果并按 title 精确选择城市", async () => {
  const source = readCtripSource();
  const start = source.indexOf("async function fillCitySelect");
  const end = source.indexOf("\nexport async function openProductEditor", start);
  const body = source.slice(start, end);
  assert.match(body, /pickCityOption/);
  assert.match(body, /Date\.now\(\) \+ 8_000/);
  assert.match(body, /ant-select-selection-selected-value/);
  assert.match(body, /\.ant-select-selection/);
  assert.match(body, /input\.waitFor\(\{ state: "visible"/);
  assert.doesNotMatch(body, /title\.endsWith\(`-\$\{city\}`\)/, "城市 endsWith 命中第一项不安全，必须走国家-城市精确匹配");
  assert.doesNotMatch(body, /selectedText\.endsWith\(`-\$\{city\}`\)/, "幂等判断也必须验证国家，不能因 endsWith 跳过");
  assert.doesNotMatch(body, /getByRole\("combobox"\)\.click\(\)/, "收起状态不能点击隐藏 combobox");
  assert.doesNotMatch(body, /chosenIndex\s*=.*:\s*0/, "城市未精确命中时禁止默认第一项");
});

test("fillCitySelect scoped 清空 Ant v3 单选：hover 后清除并等待隐藏", async () => {
  const source = readCtripSource();
  const start = source.indexOf("async function fillCitySelect");
  const end = source.indexOf("\nexport async function openProductEditor", start);
  const body = source.slice(start, end);
  // scoped 到 select 容器内的 v3 单选清除按钮
  assert.match(
    body,
    /select\.locator\("\.ant-select-selection__clear"\)/,
    "清除按钮必须 scoped 到 select 容器内的 .ant-select-selection__clear",
  );
  // 把校验限定在 clear 块（前到 waitFor hidden，后到 catch 关闭大括号）
  const clearBlockStart = body.indexOf("const clear = select.locator");
  const clearBlockEnd = body.indexOf("selectedValue.waitFor", clearBlockStart) + "selectedValue.waitFor({ state: \"hidden\", timeout: 3_000 })".length;
  const clearBlock = body.slice(clearBlockStart, clearBlockEnd);
  // 顺序：hover → assertCount(1) → click → waitFor hidden
  const hoverIdx = clearBlock.indexOf("await select.hover()");
  const assertIdx = clearBlock.indexOf("await assertCount(clear, 1");
  const clickIdx = clearBlock.indexOf("await clear.click()");
  const waitIdx = clearBlock.indexOf("selectedValue.waitFor({ state: \"hidden\", timeout: 3_000 })");
  assert.ok(hoverIdx > 0, "缺少 select.hover()");
  assert.ok(assertIdx > 0, "缺少 assertCount(clear, 1, ...)");
  assert.ok(clickIdx > 0, "缺少 clear.click()");
  assert.ok(waitIdx > 0, "缺少 selectedValue.waitFor({ state: \"hidden\" })");
  assert.ok(hoverIdx < assertIdx, "hover 必须在 assertCount 之前");
  assert.ok(assertIdx < clickIdx, "assertCount 必须在 click 之前");
  assert.ok(clickIdx < waitIdx, "click 必须在 waitFor hidden 之前");
  // 兜底抛错
  assert.match(body, /无法清除已选城市：\$\{selectedText\}/);
  // 禁止 force / 禁止 fill 隐藏 input（仅限 clear 块内）
  assert.doesNotMatch(clearBlock, /clear\.click\(\{ force: true \}\)/, "清除按钮不允许 force");
  assert.doesNotMatch(clearBlock, /clear\.fill\(/, "清除按钮不能 fill");
  assert.doesNotMatch(clearBlock, /\binput\.fill\(/, "scoped clear 块内不能 fill 隐藏 input");
});

test("fillCitySelect 打开下拉：scoped click selection 后等 input 可见，超时只重试一次 scoped click", async () => {
  const source = readCtripSource();
  const start = source.indexOf("async function fillCitySelect");
  const end = source.indexOf("\nexport async function openProductEditor", start);
  const body = source.slice(start, end);
  assert.match(body, /selection\.click\(\)/);
  assert.match(body, /select\.locator\("input\.ant-select-search__field"\)/);
  assert.match(body, /input\.waitFor\(\{ state: "visible", timeout: 5_000 \}\)/);
  // 重试路径：catch 里再点一次 selection scoped click，绝不 force，绝不 fill 隐藏 input
  // 第二次 waitFor 出现在 catch 块内（catch 没有绑定变量），取第二处。
  const firstWaitIdx = body.indexOf("input.waitFor({ state: \"visible\", timeout: 5_000 })");
  const secondWaitIdx = body.indexOf("input.waitFor({ state: \"visible\", timeout: 5_000 })", firstWaitIdx + 1);
  assert.ok(secondWaitIdx > 0, "找不到 catch 内的二次 waitFor");
  const tryIdx = body.lastIndexOf("try {", secondWaitIdx);
  assert.ok(tryIdx > 0, "找不到输入框可见性的 try");
  // 第二次 waitFor 之后取一段窗口：包含整个 catch 块尾部
  const tailStart = secondWaitIdx;
  const tailEnd = body.indexOf("await input.fill(", tailStart);
  assert.ok(tailEnd > 0, "找不到 catch 之后的 input.fill");
  const retryBlock = body.slice(tryIdx, tailEnd);
  assert.match(retryBlock, /selection\.click\(\)/, "重试必须再次 scoped 点击 selection");
  assert.doesNotMatch(retryBlock, /force:\s*true/, "重试不允许 force");
  assert.doesNotMatch(retryBlock, /\binput\.fill\(/, "重试不允许 fill 隐藏 input");
});

test("fillProductLine 优先城市一地、回退省份一地并禁止默认第一项", async () => {
  const source = readCtripSource();
  const start = source.indexOf("async function fillProductLine");
  const end = source.indexOf("\nexport async function openProductEditor", start);
  const body = source.slice(start, end);
  assert.ok(start >= 0, "找不到 fillProductLine 定义");
  assert.match(body, /baseInfo\.productLineID/);
  assert.match(body, /destinationCity[\s\S]*一地/);
  assert.match(body, /provinceBase[\s\S]*一地/);
  assert.match(body, /Date\.now\(\) \+ 10_000/);
  assert.match(body, /candidates\.includes\(text\)/);
  assert.match(body, /暂无数据/);
  assert.doesNotMatch(body, /options\.(?:first|nth\(0\))/, "产品线禁止默认第一项");
});

test("fillBasicInfo 在城市后录入产品线", async () => {
  const source = readCtripSource();
  const start = source.indexOf("export async function fillBasicInfo");
  const body = source.slice(start, source.indexOf("\n/**", start));
  const cityAnchor = body.indexOf('fillCitySelect(page, "baseInfo.destinationCityID"');
  const lineAnchor = body.indexOf("fillProductLine(page, info.destinationCity, info.province)");
  assert.ok(cityAnchor >= 0 && lineAnchor > cityAnchor, "产品线必须在目的城市之后录入");
});

test("基本信息重试会关闭残留提示弹窗", async () => {
  const source = readCtripSource();
  assert.match(source, /async function dismissKnownNoticeDialogs/);
  assert.match(source, /保存成功\|不能输入重复的国家或省或景区、景点、其他地区/);
  assert.match(source, /我知道了\|知道了/);
  assert.match(source, /waitForSaveSuccess \? 5_000 : 800/);
  assert.match(source, /dialog\.waitFor\(\{ state: "hidden", timeout: 3_000 \}\)/);
  const saveStart = source.indexOf("async function clickSafeSave");
  const saveBody = source.slice(saveStart, source.indexOf("\nasync function dismissKnownNoticeDialogs", saveStart));
  assert.match(saveBody, /current\.innerText\(\).*\.replace\(\/\\s\+\/g, ""\)/s);
  assert.match(saveBody, /text === name\.replace\(\/\\s\+\/g, ""\)/);
  assert.match(saveBody, /dismissKnownNoticeDialogs\(page, \{ waitForSaveSuccess: true \}\)/);
  const start = source.indexOf("export async function fillAndSaveBasicInfo");
  const body = source.slice(start, source.indexOf("\nasync function fillFirstVisible", start));
  assert.match(body, /dismissKnownNoticeDialogs\(page\)/);
  // basic 阶段的「下一步」与「产品图文/图文信息」tab 切换全部由新通用
  // saveThenAdvance 负责；fillAndSaveBasicInfo 不再直接调
  // waitForSectionEnabled/clickSection 走 tab 路径。
  assert.match(body, /saveThenAdvance\(page, \{/);
  assert.doesNotMatch(body, /waitForSectionEnabled\(page, \["产品图文", "图文信息"\]\)/);
  assert.doesNotMatch(body, /clickSection\(page, \["产品图文", "图文信息"\]\)/);
});

test("fillScenicAreaProvince 识别中国山西标签并幂等跳过", async () => {
  const source = readCtripSource();
  const start = source.indexOf("async function fillScenicAreaProvince");
  const end = source.indexOf("\nasync function fillServicePhone", start);
  const body = source.slice(start, end);
  assert.match(body, /container\.locator\("\.ant-tag"\)\.allTextContents\(\)/);
  assert.match(body, /text\.includes\(provinceBase\)/);
  assert.match(body, /return;/);
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

test("fillButlerContact 用稳定的 div[id=bookingControls.vendorBookingAssistant] 定位", async () => {
  const source = readCtripSource();
  const start = source.indexOf("async function fillButlerContact");
  assert.ok(start >= 0, "找不到 fillButlerContact 定义");
  const rest = source.slice(start);
  const end = rest.indexOf("\nasync function ", 1);
  const body = end >= 0 ? rest.slice(0, end) : rest;
  assert.ok(
    /div\[id="bookingControls\.vendorBookingAssistant"\]/.test(body),
    "fillButlerContact 必须用 div[id=bookingControls.vendorBookingAssistant] 收敛范围",
  );
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
  const scopeMatch = body.match(/scope\s*=\s*[^\n;]+;/);
  assert.ok(scopeMatch, "找不到 scope = ... 赋值");
  const searchAnchor = body.indexOf("await assertCount(search, 1");
  assert.ok(searchAnchor > 0, "找不到搜索输入框 assertCount 调用");
  const scopedRegion = body.slice(scopeMatch.index, searchAnchor);
  assert.ok(
    !/\.first\(\)/.test(scopedRegion),
    "fillButlerContact 在容器内仍出现 .first()，违反唯一性契约",
  );
});

test("pickKeySpotsFromItinerary 按天顺序去重并限制 3 个", () => {
  const product = productFixture({
    itinerary: [
      { day: 1, title: "第一天", spots: ["晋祠博物馆", "  晋祠博物馆  ", "平遥古城"] },
      { day: 2, title: "第二天", spots: ["平遥古城", "云冈石窟", "壶口瀑布"] },
      { day: 3, title: "第三天", spots: ["五台山"] },
    ],
  });
  assert.deepEqual(pickKeySpotsFromItinerary(product, 3), [
    "晋祠博物馆",
    "平遥古城",
    "云冈石窟",
  ]);
});

test("pickKeySpotsFromItinerary 优先挑产品推荐语中的主打景点", () => {
  const product = productFixture({
    itinerary: [
      { day: 1, title: "第一天", spots: ["柳巷", "食品街", "汾河公园"] },
      { day: 2, title: "第二天", spots: ["晋祠", "山西博物院"] },
      { day: 3, title: "第三天", spots: ["永祚寺（双塔寺）"] },
    ],
    presentation: {
      recommendation: "晋祠三绝、山西博物院晋魂展、永祚寺双塔祈福",
      features: "三大核心文化 IP",
    },
  });
  assert.deepEqual(pickKeySpotsFromItinerary(product, 3), [
    "柳巷",
    "晋祠",
    "山西博物院",
  ]);
});

test("pickKeySpotsFromItinerary 行程不足时返回实际能匹配的数量", () => {
  const product = productFixture({
    itinerary: [
      { day: 1, title: "第一天", spots: ["晋祠博物馆"] },
      { day: 2, title: "第二天", spots: ["", "  "] },
    ],
  });
  assert.deepEqual(pickKeySpotsFromItinerary(product, 3), ["晋祠博物馆"]);
});

test("pickKeySpotsFromItinerary 净化「游览」后缀 + 接团/送团/自由活动过滤", () => {
  // 来自「大同 2 天 1 晚」实际行程：第一个是接团，不应该是景点；
  // 「云冈石窟游览」「华严寺游览」「九龙壁游览」都是加了动作后缀的口述写法，
  // VBK 景点下拉里只有「云冈石窟」「华严寺」「九龙壁」。需要去掉「游览」才
  // 能命中。
  const product = productFixture({
    itinerary: [
      { day: 1, title: "第一天", spots: ["大同站/大同南站接团", "云冈石窟游览", "华严寺游览", "自由活动·大同古城"] },
      { day: 2, title: "第二天", spots: ["九龙壁游览", "大同古城墙", "善化寺游览", "古城自由活动", "送团返程"] },
    ],
  });
  assert.deepEqual(pickKeySpotsFromItinerary(product, 3), [
    "云冈石窟",
    "华严寺",
    "九龙壁",
  ]);
});

test("pickKeySpotsFromItinerary 别名括号（双塔寺）等也参与推荐语匹配", () => {
  const product = productFixture({
    itinerary: [
      { day: 1, title: "第一天", spots: ["永祚寺（双塔寺）"] },
    ],
    presentation: {
      recommendation: "永祚寺双塔祈福",
      features: "",
    },
  });
  // 「永祚寺（双塔寺）」净化后为「永祚寺」，括号别名「双塔寺」用于匹配 corpus。
  assert.deepEqual(pickKeySpotsFromItinerary(product, 3), ["永祚寺"]);
});

test("pickKeySpotsFromItinerary 大小写不敏感去重", () => {
  const product = productFixture({
    itinerary: [
      { day: 1, title: "第一天", spots: ["MaoMing", "maoming"] },
    ],
  });
  assert.deepEqual(pickKeySpotsFromItinerary(product, 3), ["MaoMing"]);
});

test("pickKeySpotsFromItinerary 跳过非字符串与非对象项", () => {
  const product = {
    ...productFixture(),
    itinerary: [
      { day: 1, title: "第一天", spots: [null, 0, "晋祠", ""] },
      null,
      { day: 2, title: "第二天", spots: "非数组" },
    ],
  } as unknown as Record<string, unknown>;
  assert.deepEqual(pickKeySpotsFromItinerary(product, 3), ["晋祠"]);
});

