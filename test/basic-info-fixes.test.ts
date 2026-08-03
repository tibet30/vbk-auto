import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  basicInfoCompletenessIssues,
  findButlerOptionIndex,
  findFirstEnabledOptionIndex,
  findProvinceOptionIndex,
  parseProduct,
  pickKeySpotsFromItinerary,
  resolveAdvanceBooking,
  shouldRefillBasicInfo,
} from "../src/main/automation/schema.js";
import { pickCityOption } from "../src/main/automation/ctrip.js";
import {
  isProductImageTextUrl,
  PRODUCT_IMAGE_TEXT_PATH,
} from "../src/main/automation/ctrip.js";

function productFixture(extra: Record<string, unknown> = {}) {
  return {
    sales: { productType: "domesticShort", productForm: "groupTour", splitGroup: false },
    basicInfo: {
      supplierProductName: "测试产品",
      supplierProductCode: "TEST-1",
      subtitle: "测试副标题",
      days: 2,
      nights: 1,
      meetingCity: "太原",
      destinationCity: "太原",
      province: "山西",
      operationNotes: "测试",
    },
    operations: { transport: "charter", pickupCity: "太原", reusePickupForDropoff: true, hotelSource: "nonPlatform", mealsIncluded: false },
    itinerary: [
      { day: 1, title: "第一天" },
      { day: 2, title: "第二天" },
    ],
    ...extra,
  };
}

test("resolveAdvanceBooking 默认 1 天 12:00", () => {
  const fallback = resolveAdvanceBooking(productFixture());
  assert.deepEqual(fallback, { days: 1, time: "12:00" });
});

test("resolveAdvanceBooking 读取显式配置", () => {
  const configured = resolveAdvanceBooking(productFixture({
    operations: { transport: "charter", pickupCity: "太原", reusePickupForDropoff: true, hotelSource: "nonPlatform", mealsIncluded: false, bookingControls: { advanceBooking: { days: 3, time: "18:30" } } },
  }));
  assert.deepEqual(configured, { days: 3, time: "18:30" });
});

test("resolveAdvanceBooking 非法 days 返回 null", () => {
  const invalid = resolveAdvanceBooking(productFixture({
    operations: { transport: "charter", pickupCity: "太原", reusePickupForDropoff: true, hotelSource: "nonPlatform", mealsIncluded: false, bookingControls: { advanceBooking: { days: -1, time: "22:00" } } },
  }));
  assert.equal(invalid, null);
});

test("resolveAdvanceBooking 非法 time 返回 null", () => {
  const invalid = resolveAdvanceBooking(productFixture({
    operations: { transport: "charter", pickupCity: "太原", reusePickupForDropoff: true, hotelSource: "nonPlatform", mealsIncluded: false, bookingControls: { advanceBooking: { days: 1, time: "25:99" } } },
  }));
  assert.equal(invalid, null);
});

test("parseProduct 接受 advanceBooking 配置", () => {
  const product = parseProduct(productFixture({
    operations: { transport: "charter", pickupCity: "太原", reusePickupForDropoff: true, hotelSource: "nonPlatform", mealsIncluded: false, bookingControls: { advanceBooking: { days: 2, time: "20:00" } } },
  }));
  assert.equal(product.operations!.bookingControls!.advanceBooking!.days, 2);
  assert.equal(product.operations!.bookingControls!.advanceBooking!.time, "20:00");
});

test("parseProduct 拒绝非法 time 格式", () => {
  assert.throws(() => parseProduct(productFixture({
    operations: { transport: "charter", pickupCity: "太原", reusePickupForDropoff: true, hotelSource: "nonPlatform", mealsIncluded: false, bookingControls: { advanceBooking: { days: 1, time: "下午" } } },
  })), /HH:mm/);
});

test("shouldRefillBasicInfo 没有 productId 必须重跑", () => {
  const result = shouldRefillBasicInfo({ productId: undefined, product: productFixture() });
  assert.equal(result.refill, true);
  assert.equal(result.reason, "noProductId");
});

test("shouldRefillBasicInfo basicInfoSaved=true + productId + 旧 JSON 仍重跑", () => {
  // 真实生产环境 productId=76503615、basicInfoSaved=1、JSON 是旧版本（无
  // bookingControls）时，必须继续重跑 basic，依靠幂等填写 + 红错校验保证
  // 安全，而不是被本地判定为「完整」直接跳过。
  const result = shouldRefillBasicInfo({
    productId: "76503615",
    basicInfoSaved: true,
    product: productFixture(),
  });
  assert.equal(result.refill, true);
  assert.ok(result.reason === "retry" || result.reason === "complete");
});

test("shouldRefillBasicInfo 任意 productId 已存在都重跑 basic", () => {
  // 任意 productId 存在时都应返回 refill=true；具体重跑策略由调用方
  // 配合 assertBasicInfoNoRedErrors 保证幂等。
  const result = shouldRefillBasicInfo({
    productId: "123",
    basicInfoSaved: true,
    product: productFixture(),
  });
  assert.equal(result.refill, true);
});

test("阶段重试会在当前页面继续，openProductEditor 带 stayOnCurrentTab 不拽回基本信息", async () => {
  const source = await fs.readFile("src/main/automation.ts", "utf8");
  const ctripSource = await fs.readFile("src/main/automation/ctrip.ts", "utf8");

  // 用户偏好「在当前页面去重试」：中间阶段重试不再调 openProductEditor
  // 拽回「基本信息」 tab。openProductEditor 必须接受 stayOnCurrentTab 选项
  // 并在 true 时不调用 ensureBasicInfoTabVisible。
  assert.match(source, /openProductEditor\(page, productId!,\s*\{\s*stayOnCurrentTab:\s*true\s*\}\)/);
  assert.match(ctripSource, /export async function openProductEditor\(page, productId, options = \{\}\)/);
  assert.match(ctripSource, /const \{ stayOnCurrentTab = false \} = options;/);
  assert.match(ctripSource, /if \(stayOnCurrentTab\)\s*\{\s*return;\s*\}/);
  assert.doesNotMatch(
    source,
    /重试 \$\{retryFrom\} 前，正在重新录入并验证产品信息/,
    "中间阶段重试不再走「重新录入产品信息」路径，偏好当前页面去重试",
  );
  assert.match(source, /fillAndSaveBasicInfo\(page, product, butlerSelection, \{ servicePhone, keySpots, scenicSpotLogs, disambiguator[^}]* \}\)/);
  // 完成门禁移到通用 saveThenAdvance helper；旧 basic-only clickBasicInfoNextStep
  // 与 waitForSectionEnabled / clickSection 的契约已删除，由 helper 统一负责
  // 「精确下一步 + 保存成功提示 + 两种成功门禁」。
  assert.match(ctripSource, /async function saveThenAdvance\(/);
  assert.match(ctripSource, /name: "下一步", exact: true/);
  assert.match(ctripSource, /productImageText/);
  assert.match(ctripSource, /await comboboxes\.nth\(0\)\.click\(\)/);
  assert.match(ctripSource, /await comboboxes\.nth\(1\)\.click\(\)/);
  assert.match(ctripSource, /text !== "Not Found"/);
});

test("retryFrom>0 也由 basic runner 包裹，else 不再直接 fillAndSaveBasicInfo/setBasicInfoSaved", async () => {
  // 锁死行为：retryFrom>0 分支只做 openProductEditor（带 stayOnCurrentTab）
  // + 精确日志，不允许在 else 块里直接调用 fillAndSaveBasicInfo 或
  // setBasicInfoSaved，也不允许写 basicInfoSaved = true；真正的 basic
  // 填写统一交给下方 runPhaseWithRecovery(makeCtx("basic", basicExecute, 0))
  // 这一处。
  const source = await fs.readFile("src/main/automation.ts", "utf8");

  // 切出 retryFrom>0 的 else 块：从 `} else {`（紧跟在 startIndex === 0 if 之后）
  // 到匹配的 `}` 之前；用花括号计数避开注释里的 `}`。
  const elseMarker = source.match(/\n      \} else \{\n/);
  assert.ok(elseMarker, "找不到 retryFrom>0 的 else 分支标记");
  const elseStart = elseMarker.index! + elseMarker[0].length;
  let depth = 1;
  let elseEnd = -1;
  for (let i = elseStart; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) { elseEnd = i; break; }
    }
  }
  assert.ok(elseEnd > 0, "无法定位 else 块的结束花括号");
  const elseBody = source.slice(elseStart, elseEnd);

  // else 块必须调 openProductEditor 且带上 stayOnCurrentTab=true
  assert.match(
    elseBody,
    /openProductEditor\(page, productId!,\s*\{\s*stayOnCurrentTab:\s*true\s*\}\)/,
    "else 必须用 stayOnCurrentTab 调 openProductEditor，偏好当前页面去重试",
  );
  // 保留「已从 ${retryFrom} 阶段继续录入」日志
  assert.match(
    elseBody,
    /已从 \$\{retryFrom\} 阶段继续录入（当前页面）/,
    "else 必须记录「从 ${retryFrom} 阶段继续录入（当前页面）」日志",
  );

  // else 块内禁止：直接 fillAndSaveBasicInfo、setBasicInfoSaved、basicInfoSaved = true
  assert.doesNotMatch(
    elseBody,
    /fillAndSaveBasicInfo/,
    "else 块禁止直接 fillAndSaveBasicInfo，必须由 basic runner 统一执行",
  );
  assert.doesNotMatch(
    elseBody,
    /setBasicInfoSaved/,
    "else 块禁止写 setBasicInfoSaved，必须由 basic runner 内 fillAndSaveBasicInfo 成功后置位",
  );
  assert.doesNotMatch(
    elseBody,
    /basicInfoSaved\s*=\s*true/,
    "else 块禁止写 basicInfoSaved = true，必须由 basic runner 内 fillAndSaveBasicInfo 成功后置位",
  );
  // else 块也不允许直接把 phases[0] 标 completed：完成门禁交给 runner。
  assert.doesNotMatch(
    elseBody,
    /run\.phases\[0\]\.status\s*=\s*"completed"/,
    "else 块禁止直接把 basic 阶段标记为 completed，必须由 runner 统一完成",
  );

  // 下方必须存在一处（且只能期望一处）basic runner 调用：
  // runPhaseWithRecovery(makeCtx("basic", basicExecute, 0))
  const basicRunnerMatches = source.match(
    /runPhaseWithRecovery\(makeCtx\(\s*"basic"\s*,\s*basicExecute\s*,\s*0\s*\)\)/g,
  );
  assert.ok(basicRunnerMatches, "必须存在统一一次的 basic runner 调用");
  assert.equal(
    basicRunnerMatches!.length,
    1,
    `basic runner 调用必须只有一处，实际找到 ${basicRunnerMatches!.length} 处`,
  );

  // basic runner 之后必须做 needs_user 收敛 + productId 校验 + 成功日志
  const runnerIdx = source.indexOf('runPhaseWithRecovery(makeCtx("basic", basicExecute, 0))');
  const tail = source.slice(runnerIdx);
  assert.match(tail, /needs_user/);
  assert.match(tail, /产品 ID 缺失，无法继续后续阶段/);
  assert.match(tail, /产品基本信息已保存：\$\{productId\}/);
});

test("basicExecute 开头清空 scenicSpotLogs，防止 runner 重试重复记录", async () => {
  const source = await fs.readFile("src/main/automation.ts", "utf8");
  // 切出 basicExecute 的函数体：从 `const basicExecute = async () => {`
  // 到下一个匹配的 `};` 之前。
  const startMatch = source.match(/const basicExecute = async \(\) => \{/);
  assert.ok(startMatch, "找不到 basicExecute 定义");
  const bodyStart = startMatch.index! + startMatch[0].length;
  // 函数体内紧跟 phaseRecord 之后必须先 scenicSpotLogs.length = 0，再做 shouldRefillBasicInfo 判断。
  const phaseRecordIdx = source.indexOf("phaseRecord(\"basic\")", bodyStart);
  assert.ok(phaseRecordIdx > 0, "basicExecute 缺少 phaseRecord(\"basic\")");
  const refillIdx = source.indexOf("shouldRefillBasicInfo", phaseRecordIdx);
  assert.ok(refillIdx > 0, "basicExecute 缺少 shouldRefillBasicInfo 调用");
  const region = source.slice(phaseRecordIdx, refillIdx);
  assert.match(
    region,
    /scenicSpotLogs\.length\s*=\s*0/,
    "basicExecute 必须在 phaseRecord 之后、shouldRefillBasicInfo 之前清空 scenicSpotLogs",
  );
});

test("basicInfoCompletenessIssues 报告省份缺失", () => {
  const product = productFixture();
  delete (product.basicInfo as Record<string, unknown>).province;
  const issues = basicInfoCompletenessIssues(product);
  assert.ok(issues.includes("国家景区（省份）"));
});

test("basicInfoCompletenessIssues 报告非法 advanceBooking", () => {
  const product = productFixture({
    operations: { transport: "charter", pickupCity: "太原", reusePickupForDropoff: true, hotelSource: "nonPlatform", mealsIncluded: false, bookingControls: { advanceBooking: { days: 1, time: "下午" } } },
  });
  const issues = basicInfoCompletenessIssues(product);
  assert.ok(issues.includes("提前预订"));
});

test("示例样例仍然可解析（旧数据兼容）", async () => {
  const raw = await fs.readFile("examples/taiyuan-private-2d1n.json", "utf8");
  const product = parseProduct(JSON.parse(raw));
  assert.equal(product.basicInfo.province, "山西");
  assert.equal(product.operations!.bookingControls, undefined);
});

test("示例样例可加 bookingControls 但不再有 localInfo", async () => {
  const raw = JSON.parse(await fs.readFile("examples/taiyuan-private-2d1n.json", "utf8"));
  raw.operations.bookingControls = { advanceBooking: { days: 2, time: "20:30" }, butler: { contactCardId: 1753732, displayName: "张三", providerId: 1279416 } };
  const product = parseProduct(raw);
  assert.equal(product.operations!.bookingControls!.advanceBooking!.days, 2);
  assert.equal(product.operations!.bookingControls!.butler!.contactCardId, 1753732);
});

test("findFirstEnabledOptionIndex 选第一个可用非 disabled 项", () => {
  const index = findFirstEnabledOptionIndex(
    ["A", "B", "C"],
    [true, false, true],
  );
  assert.equal(index, 1);
});

test("findFirstEnabledOptionIndex 全部 disabled 返回 -1", () => {
  const index = findFirstEnabledOptionIndex(["A", "B"], [true, true]);
  assert.equal(index, -1);
});

test("findFirstEnabledOptionIndex 跳过空字符串和 emptyTexts", () => {
  const index = findFirstEnabledOptionIndex(
    ["", "暂无数据", "C"],
    [false, false, false],
    ["暂无数据"],
  );
  assert.equal(index, 2);
});

test("findProvinceOptionIndex 精确匹配", () => {
  assert.equal(findProvinceOptionIndex(["北京", "山西", "陕西"], "山西"), 1);
});

test("findProvinceOptionIndex 兼容「省」后缀", () => {
  assert.equal(findProvinceOptionIndex(["北京市", "山西省", "陕西"], "山西"), 1);
  assert.equal(findProvinceOptionIndex(["北京", "山西"], "山西省"), 1);
});

test("findProvinceOptionIndex 兼容 VBK 远程结果附带国家名", () => {
  assert.equal(findProvinceOptionIndex(["山西中国", "西山省利比亚"], "山西省"), 0);
});

test("findProvinceOptionIndex 未命中返回 -1", () => {
  assert.equal(findProvinceOptionIndex(["北京", "陕西"], "山西"), -1);
});

test("findButlerOptionIndex 优先按 contactCardId 匹配", () => {
  const index = findButlerOptionIndex(
    [
      { value: "100", label: "客服A" },
      { value: "200", label: "客服B" },
    ],
    { contactCardId: 200, displayName: "客服A" },
  );
  assert.equal(index, 1);
});

test("findButlerOptionIndex 失败回退按 displayName", () => {
  const index = findButlerOptionIndex(
    [
      { value: "100", label: "客服A" },
      { value: "999", label: "客服B" },
    ],
    { contactCardId: 200, displayName: "客服B" },
  );
  assert.equal(index, 1);
});

test("findButlerOptionIndex 都未命中返回 -1", () => {
  const index = findButlerOptionIndex(
    [{ value: "100", label: "客服A" }],
    { contactCardId: 200, displayName: "客服B" },
  );
  assert.equal(index, -1);
});

test("findButlerOptionIndex 可匹配 VBK 拼接联系方式的姓名且不误选同名前缀", () => {
  const index = findButlerOptionIndex(
    [
      { value: "", label: "安思科-国际 ansike@qq.com +86 18835112829" },
      { value: "", label: "安思科 ansike@qq.com +86 15910250965" },
    ],
    { contactCardId: 1368298, displayName: "安思科" },
  );
  assert.equal(index, 1);
});

test("findButlerOptionIndex 忽略 VBK 选项前置图标字符", () => {
  const index = findButlerOptionIndex(
    [
      { value: "", label: "󰄼 安思科 ansike@qq.com +86 15910250965 - " },
      { value: "", label: "安思科-国际 ansike@qq.com +86 18835112829 - " },
    ],
    { contactCardId: 1368298, displayName: "安思科" },
  );
  assert.equal(index, 0);
});

// 管家联系人 fillButlerContact 的回归防护：scope.count() 返回 Promise，
// 在三元里永远 truthy，会让后续 page.locator 退化成「整页第一个 combobox」，
// 静默错命中其它字段。这里同时锁死容器选择器与「不使用 first」契约。
const here = path.dirname(fileURLToPath(import.meta.url));
const ctripSourcePath = path.resolve(here, "..", "src", "main", "automation", "ctrip.ts");

test("fillCitySelect 等待完整远程结果并按 title 精确选择城市", async () => {
  const source = await fs.readFile(ctripSourcePath, "utf8");
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
  const source = await fs.readFile(ctripSourcePath, "utf8");
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
  const source = await fs.readFile(ctripSourcePath, "utf8");
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
  const source = await fs.readFile(ctripSourcePath, "utf8");
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
  const source = await fs.readFile(ctripSourcePath, "utf8");
  const start = source.indexOf("export async function fillBasicInfo");
  const body = source.slice(start, source.indexOf("\n/**", start));
  const cityAnchor = body.indexOf('fillCitySelect(page, "baseInfo.destinationCityID"');
  const lineAnchor = body.indexOf("fillProductLine(page, info.destinationCity, info.province)");
  assert.ok(cityAnchor >= 0 && lineAnchor > cityAnchor, "产品线必须在目的城市之后录入");
});

test("基本信息重试会关闭残留提示弹窗", async () => {
  const source = await fs.readFile(ctripSourcePath, "utf8");
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
  const source = await fs.readFile(ctripSourcePath, "utf8");
  const start = source.indexOf("async function fillScenicAreaProvince");
  const end = source.indexOf("\nasync function fillServicePhone", start);
  const body = source.slice(start, end);
  assert.match(body, /container\.locator\("\.ant-tag"\)\.allTextContents\(\)/);
  assert.match(body, /text\.includes\(provinceBase\)/);
  assert.match(body, /return;/);
});

test("fillAdvanceBooking 通过时间面板提交受控时间值", async () => {
  const source = await fs.readFile(ctripSourcePath, "utf8");
  const start = source.indexOf("async function fillAdvanceBooking");
  const end = source.indexOf("\nasync function fillLocalTravelAgency", start);
  const body = source.slice(start, end);
  assert.match(body, /\.ant-time-picker-panel:visible/);
  assert.match(body, /\.ant-time-picker-panel-select/);
  assert.match(body, /committed !== time/);
  assert.doesNotMatch(body, /timeInput\.fill\(/, "受控时间组件不能再用 fill 直接赋值");
});

test("fillButlerContact 不再使用 scope.count() ? scope : page 的歧义写法", async () => {
  const source = await fs.readFile(ctripSourcePath, "utf8");
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
  const source = await fs.readFile(ctripSourcePath, "utf8");
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
  const source = await fs.readFile(ctripSourcePath, "utf8");
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

test("fillServicePhone 存在且严格精确匹配、不默认第一项", async () => {
  const source = await fs.readFile(ctripSourcePath, "utf8");
  assert.match(source, /async function fillServicePhone\(/);
  // 禁止 .first() / .nth(0) 逃避，必须用严格相等的精确匹配。
  const start = source.indexOf("async function fillServicePhone(");
  assert.ok(start >= 0, "找不到 fillServicePhone 定义");
  const rest = source.slice(start);
  const end = rest.indexOf("\nasync function ", 1);
  const body = end >= 0 ? rest.slice(0, end) : rest;
  assert.match(body, /label\[for=\\"baseInfo\.phone400\\"\]/, "必须使用 VBK 真实的 400 电话字段 ID");
  assert.ok(/text === target/.test(body), "fillServicePhone 必须用严格相等精确匹配");
  assert.ok(/matchIndex\s*<\s*0/.test(body), "fillServicePhone 未命中必须抛错");
  // 在「收集选项文本」之后到「点选」之前，禁掉任何 .first()/.nth(0) 偷懒写法。
  const collectAnchor = body.indexOf("await options.allTextContents()");
  assert.ok(collectAnchor > 0, "找不到 fillServicePhone 的选项收集调用");
  const clickAnchor = body.indexOf("await options.nth(matchIndex).click()");
  assert.ok(clickAnchor > collectAnchor, "找不到 fillServicePhone 的精确点击");
  const region = body.slice(collectAnchor, clickAnchor);
  assert.ok(!/\.first\(/.test(region), "fillServicePhone 在收集-点选之间出现 .first()");
  assert.ok(!/\.nth\(0\)/.test(region), "fillServicePhone 在收集-点选之间出现 .nth(0)");
});

test("fillScenicAreaSpots 存在并以严格相等匹配、不默认第一项", async () => {
  const source = await fs.readFile(ctripSourcePath, "utf8");
  assert.match(source, /async function fillScenicAreaSpots\(/);
  const start = source.indexOf("async function fillScenicAreaSpots(");
  assert.ok(start >= 0, "找不到 fillScenicAreaSpots 定义");
  const rest = source.slice(start);
  const end = rest.indexOf("\nasync function ", 1);
  const body = end >= 0 ? rest.slice(0, end) : rest;
  assert.match(body, /chooseExact\(comboboxes\.nth\(3\), spot/);
  assert.match(body, /chooseExact\(comboboxes\.nth\(2\), spot/);
  assert.match(body, /aliases\.includes\(text\)/, "fillScenicAreaSpots 必须用可控别名精确匹配");
  assert.match(body, /options\.nth\(index\)\.innerText/);
  assert.match(body, /景点“\$\{spot\}”已选择但未成功添加/);
  assert.match(body, /await combobox\.click\(\)/);
  // 数据风险弹窗必须能跳过该景点，遵用户指示“遇到数据风险就跳过该景点”。
  assert.match(body, /dismissDataRiskDialog/);
  assert.match(body, /数据风险弹窗.*跳过该景点/);
  assert.doesNotMatch(body, /combobox\.locator\("\.ant-select-selection"\)/);
  assert.doesNotMatch(body, /type\("中国"/);
  assert.doesNotMatch(body, /chooseExact\(comboboxes\.nth\(1\)/, "国内景点无需重复选择省份");
  assert.doesNotMatch(body, /cityLabel/);
  assert.ok(/logs\.push/.test(body), "fillScenicAreaSpots 未命中必须记录日志");
  assert.doesNotMatch(body, /options\.(?:first|nth\(0\))/, "禁止默认第一项");
});

test("fillLocalTravelAgency 重试时清空旧值且只保留第一个地接社", async () => {
  const source = await fs.readFile(ctripSourcePath, "utf8");
  const start = source.indexOf("async function fillLocalTravelAgency");
  const end = source.indexOf("\nasync function fillButlerContact", start);
  const body = source.slice(start, end);
  assert.match(body, /ant-select-selection__choice__remove/);
  assert.match(body, /remove\.click\(\{ force: true \}\)/);
  assert.match(body, /searchInput\.click\(\)/);
  assert.match(body, /findFirstEnabledOptionIndex/);
  assert.match(body, /selectedChoices\.count\(\)\) !== 1/);
  assert.match(body, /committedText\.includes\(texts\[targetIndex\]\)/);
});

// pickCityOption 是 fillCitySelect 拆出来的纯函数，下面用真实 bug 场景锁定
// 行为：国内行程优先“中国-大同”，明确指定 preferredCountry="中国" 时绝不能
// 回退到“朝鲜-大同”，未指定时多国同名要报歧义。

test("pickCityOption 指定中国时优先匹配中国-大同，不回退到朝鲜-大同", () => {
  const labels = ["朝鲜-大同", "中国-大同"];
  const result = pickCityOption(labels, "大同", "中国");
  assert.equal(result.kind, "matched");
  assert.equal(result.kind === "matched" && result.label, "中国-大同");
  assert.equal(result.kind === "matched" && result.index, 1);
});

test("pickCityOption 指定中国时遇到朝鲜-大同不能算命中", () => {
  const labels = ["朝鲜-大同"];
  const result = pickCityOption(labels, "大同", "中国");
  assert.equal(result.kind, "missing");
  assert.equal(result.kind === "missing" && result.reason, "wrongCountry");
  assert.deepEqual(result.kind === "missing" && result.seen, ["朝鲜-大同"]);
});

test("pickCityOption 未指定国家时多个同名候选要报歧义而非默认第一项", () => {
  const labels = ["朝鲜-大同", "中国-大同"];
  const result = pickCityOption(labels, "大同");
  assert.equal(result.kind, "ambiguous");
  assert.deepEqual(result.kind === "ambiguous" && result.labels, ["朝鲜-大同", "中国-大同"]);
});

test("pickCityOption 未指定国家时唯一候选精确命中", () => {
  const labels = ["中国-大同"];
  const result = pickCityOption(labels, "大同");
  assert.equal(result.kind, "matched");
  assert.equal(result.kind === "matched" && result.label, "中国-大同");
  assert.equal(result.kind === "matched" && result.index, 0);
});

test("pickCityOption 未指定国家时裸城市名作为唯一候选也允许命中", () => {
  const result = pickCityOption(["大同"], "大同");
  assert.equal(result.kind, "matched");
  assert.equal(result.kind === "matched" && result.label, "大同");
});

test("pickCityOption 找不到候选返回 notFound 并保留所有可见项", () => {
  const labels = ["中国-太原", "中国-临汾"];
  const result = pickCityOption(labels, "大同");
  assert.equal(result.kind, "missing");
  assert.equal(result.kind === "missing" && result.reason, "notFound");
  assert.deepEqual(result.kind === "missing" && result.seen, ["中国-太原", "中国-临汾"]);
});

test("pickCityOption 指定中国时同国家多个同名项要报歧义", () => {
  const result = pickCityOption(["中国-大同", "中国-大同"], "大同", "中国");
  assert.equal(result.kind, "ambiguous");
  assert.equal(result.kind === "ambiguous" && result.labels.length, 2);
});

test("fillCitySelect 幂等判断：朝鲜-大同已选时在指定中国下必须重新打开下拉", async () => {
  // 用源码断言：原 endsWith 判等已删除，幂等分支必须调用 pickCityOption 并
  // 把 preferredCountry 一并传入；这样“朝鲜-大同”不会让中国行程被误认为已选。
  const source = await fs.readFile(ctripSourcePath, "utf8");
  const start = source.indexOf("async function fillCitySelect");
  const end = source.indexOf("\nexport async function openProductEditor", start);
  const body = source.slice(start, end);
  // 幂等判断那一步必须把 selectedText 包进数组喂给 pickCityOption，且带上
  // preferredCountry；缺一会让 endsWith 旧逻辑残留。
  assert.match(body, /pickCityOption\(\[selectedText\], city, preferredCountry\)/);
  assert.ok(!/selectedText\.endsWith/.test(body), "幂等分支不能再用 endsWith 直接命中");
});

test("fillBasicInfo 在省份非空时给两处城市都传中国，且 fallback 行为受控", async () => {
  const source = await fs.readFile(ctripSourcePath, "utf8");
  const start = source.indexOf("export async function fillBasicInfo");
  const end = source.indexOf("\nasync function fillScenicAreaProvince", start);
  const body = source.slice(start, end);
  // 两处 fillCitySelect 必须都拿到 preferredCountry 形参（由 info.province 派生）。
  // 后期会追加 5th 参数（AI 上下文）；这里只检查形参出现，不限位。
  const matches = body.match(/fillCitySelect\([^)]+\)/g) || [];
  assert.ok(matches.length >= 2, "fillBasicInfo 必须调用 fillCitySelect 至少两次");
  for (const call of matches) {
    assert.match(
      call,
      /,\s*preferredCountry\b/,
      `fillCitySelect 必须显式传 preferredCountry 形参：${call}`,
    );
  }
  // 没有省份时不允许静默传 "中国"，应该传 undefined 让 pickCityOption 走老路径。
  assert.match(body, /info\.province\s*&&\s*info\.province\.trim\(\)\s*\?\s*"中国"\s*:\s*undefined/);
});

// —— 通用 save-then-advance helper 的回归锁 ——————
// 真实 VBK baseInfoMerge 页面同时存在白色「保存」和蓝色「下一步」两个提
// 交流入口；只有「下一步」会真正解锁下一个 tab。本批测试负责锁死新通用
// helper 的契约：精确唯一「下一步」按钮，禁止「提交审核并下一步」前缀
// 误命中，两种成功门禁（URL 已落点 / tab 解锁），失败门禁给出明确错误，
// 严格不调用 submitCurrentSectionAndNext、不触碰提审/发布/价格库存。

function helperBody(source: string, marker: string, endMarker: string) {
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `找不到 helper 标记：${marker}`);
  const end = source.indexOf(endMarker, start);
  return source.slice(start, end > 0 ? end : source.length);
}

function stripComments(source: string): string {
  return source
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

test("saveThenAdvance 是 ctrip.ts 内的通用 helper，禁止 clickBasicInfoNextStep/classifyBasicInfoSaveOutcome 残留", async () => {
  const ctrip = await fs.readFile(ctripSourcePath, "utf8");
  // 通用 helper 必须存在。
  assert.match(ctrip, /async function saveThenAdvance\(/);
  // basic-only 的 clickBasicInfoNextStep / classifyBasicInfoSaveOutcome
  // 已删除（被 saveThenAdvance 与 isProductImageTextUrl 替代）。
  assert.doesNotMatch(
    ctrip,
    /async function clickBasicInfoNextStep/,
    "clickBasicInfoNextStep 已合并到 saveThenAdvance，禁止再单独存在",
  );
  assert.doesNotMatch(
    ctrip,
    /export function classifyBasicInfoSaveOutcome/,
    "classifyBasicInfoSaveOutcome 已并入 saveThenAdvance 内的 isTargetUrl，禁止再单独存在",
  );
});

test("saveThenAdvance 精确 role=button name=下一步 exact=true 且要求唯一可见 enabled", async () => {
  const ctrip = await fs.readFile(ctripSourcePath, "utf8");
  const body = helperBody(
    ctrip,
    "async function saveThenAdvance(",
    "\nasync function findUnlockedSectionLabel",
  );
  // 精确定位规则：role=button + name=下一步 + exact=true（nextButtonLabel 默认值）。
  assert.match(body, /page\.getByRole\("button", \{ name: nextButtonLabel, exact: true \}\)/);
  // 唯一性断言：count !== 1 直接抛错。
  assert.match(body, /if \(count !== 1\)/);
  // 错误必须带阶段 / 观测 URL / 目标 tab 三类上下文。
  assert.match(body, /phase/);
  assert.match(body, /targetTabLabel/);
  assert.match(body, /观测 URL=/);
  assert.match(body, /目标 tab=/);
  // 必须检查可见 / enabled / aria-disabled；缺一会让旧 bug 复发。
  assert.match(body, /!\(await button\.isVisible\(\)\)/);
  assert.match(body, /!\(\(await button\.isEnabled\(\)\) \?\? true\)/);
  assert.match(body, /aria-disabled.*true/);
});

test("saveThenAdvance 禁止匹配「提交审核并下一步」并禁止调用 submitCurrentSectionAndNext", async () => {
  const ctrip = await fs.readFile(ctripSourcePath, "utf8");
  const helperStart = ctrip.indexOf("async function saveThenAdvance(");
  const helperEnd = ctrip.indexOf("async function findUnlockedSectionLabel(", helperStart);
  const helper = ctrip.slice(helperStart, helperEnd);
  // 只看实现代码不看注释：把 // 开头的注释整段删掉再断言。
  const codeOnly = stripComments(helper);
  assert.ok(
    !codeOnly.includes("提交审核并下一步"),
    "saveThenAdvance 实现中禁止匹配「提交审核并下一步」",
  );
  assert.ok(
    !codeOnly.includes("submitCurrentSectionAndNext"),
    "saveThenAdvance 必须不调用 submitCurrentSectionAndNext",
  );
  // 「提交审核并下一步」是已存在的提审入口，源码里仍存在但 helper 不得引用。
  assert.match(ctrip, /async function submitCurrentSectionAndNext\(/);
});

test("saveThenAdvance 点击后处理「保存成功」提示并点我知道了/知道了/确定", async () => {
  const ctrip = await fs.readFile(ctripSourcePath, "utf8");
  const helperStart = ctrip.indexOf("async function saveThenAdvance(");
  const helperEnd = ctrip.indexOf("async function findUnlockedSectionLabel(", helperStart);
  const helper = ctrip.slice(helperStart, helperEnd);
  // 必须依赖 dismissKnownNoticeDialogs 的保存成功分支。
  assert.match(helper, /dismissKnownNoticeDialogs\(page, \{ waitForSaveSuccess: true \}\)/);
  // dismissKnownNoticeDialogs 内部必须能识别「保存成功」并点确认按钮。
  const dialogBody = helperBody(
    ctrip,
    "async function dismissKnownNoticeDialogs",
    "\nasync function submitCurrentSectionAndNext",
  );
  assert.match(dialogBody, /我知道了\|知道了\|确 定\|确定/);
});

test("saveThenAdvance 失败门禁：未跳转且未解锁时报明确错误，且带阶段/目标/观测 URL/目标 tab 上下文", async () => {
  const ctrip = await fs.readFile(ctripSourcePath, "utf8");
  const helperStart = ctrip.indexOf("async function saveThenAdvance(");
  const helperEnd = ctrip.indexOf("async function findUnlockedSectionLabel(", helperStart);
  const helper = ctrip.slice(helperStart, helperEnd);
  // 失败错误必须包含「阶段点击…后未到达目标…：URL=…目标 tab 仍未解锁」
  // 的上下文（阶段名、目标 tab、观测 URL、目标 tab 未解锁说明）。
  assert.match(helper, /\$\{phase\}点击/);
  assert.match(helper, /未到达目标「\$\{targetTabLabel\}」/);
  assert.match(helper, /URL=\$\{observedUrl\}/);
  assert.match(helper, /目标 tab 仍未解锁/);
});

test("saveThenAdvance 跳页命中后立刻返回，不再二次点 tab", async () => {
  const ctrip = await fs.readFile(ctripSourcePath, "utf8");
  const helperStart = ctrip.indexOf("async function saveThenAdvance(");
  const helperEnd = ctrip.indexOf("async function findUnlockedSectionLabel(", helperStart);
  const helper = ctrip.slice(helperStart, helperEnd);
  // 已跳转分支（`if (navigated)` → return）到 tabUnlocked 分支之间，
  // 不允许出现任何 clickSection 调用。
  const navigatedAnchor = helper.indexOf("if (navigated)");
  assert.ok(navigatedAnchor >= 0, "saveThenAdvance 必须存在 navigated 分支");
  const navigatedBlock = helper.slice(
    navigatedAnchor,
    helper.indexOf("if (unlockedLabel)", navigatedAnchor),
  );
  assert.doesNotMatch(navigatedBlock, /clickSection/, "已跳转分支不允许再点 tab");
});

test("saveThenAdvance 不做任何提审、发布、上架、库存、价格动作", async () => {
  const ctrip = await fs.readFile(ctripSourcePath, "utf8");
  const helperStart = ctrip.indexOf("async function saveThenAdvance(");
  const helperEnd = ctrip.indexOf("async function findUnlockedSectionLabel(", helperStart);
  const helper = ctrip.slice(helperStart, helperEnd);
  const codeOnly = stripComments(helper);
  const blacklist = [
    "提交审核",
    "批量上线",
    "设为有效",
    "价格库存",
    "priceInventory",
    "fillAndSubmitPricingInventory",
    "publishProduct",
    "submitProductReview",
  ];
  for (const term of blacklist) {
    assert.ok(
      !codeOnly.includes(term),
      `saveThenAdvance 禁止涉及 basic 以外的阶段动作：${term}`,
    );
  }
});

// —— 三处接线断言：basic / presentation / itinerary 必须调用 saveThenAdvance ——
test("接线 1：fillAndSaveBasicInfo 接入 saveThenAdvance，目标 productImageText + 产品图文/图文信息 tab", async () => {
  const ctrip = await fs.readFile(ctripSourcePath, "utf8");
  const fillStart = ctrip.indexOf("export async function fillAndSaveBasicInfo");
  const fillEnd = ctrip.indexOf("async function fillRecommendationReasons", fillStart);
  const body = ctrip.slice(fillStart, fillEnd > 0 ? fillEnd : ctrip.length);
  // 必须前后两次 assertBasicInfoNoRedErrors 红错门禁（保存前 + 推进后）。
  const redCalls = (body.match(/assertBasicInfoNoRedErrors\(page\)/g) || []).length;
  assert.ok(redCalls >= 2, "fillAndSaveBasicInfo 必须前后两次红错门禁");
  // 必须调用 saveThenAdvance，传 isTargetUrl: isProductImageTextUrl 与
  // 目标 tab 列表 ["产品图文", "图文信息"]。
  assert.match(body, /saveThenAdvance\(page, \{/);
  assert.match(body, /isTargetUrl: isProductImageTextUrl/);
  assert.match(body, /targetTabLabels: \["产品图文", "图文信息"\]/);
  // basic 阶段严禁再出现 clickBasicInfoNextStep / classifyBasicInfoSaveOutcome。
  assert.doesNotMatch(body, /clickBasicInfoNextStep/);
  assert.doesNotMatch(body, /classifyBasicInfoSaveOutcome/);
});

test("接线 2：fillAndSavePresentation 接入 saveThenAdvance，目标 行程描述", async () => {
  const ctrip = await fs.readFile(ctripSourcePath, "utf8");
  const presIdx = ctrip.indexOf("export async function fillAndSavePresentation");
  const presBody = ctrip.slice(presIdx, ctrip.indexOf("function dayScopeFor", presIdx));
  assert.match(presBody, /saveThenAdvance\(page, \{/);
  assert.match(presBody, /targetTabLabels: \["行程描述"\]/);
  assert.match(presBody, /targetTabLabel: "行程描述"/);
  // presentation 不再自己点保存按钮（已交给 saveThenAdvance 内部）
  assert.doesNotMatch(
    presBody,
    /await clickSafeSave\(page, \["保存", "保存并下一步"\]\)/,
    "fillAndSavePresentation 的保存按钮调用已上交给 saveThenAdvance",
  );
  assert.doesNotMatch(presBody, /clickBasicInfoNextStep/);
  assert.doesNotMatch(presBody, /waitForSectionEnabled/);
});

test("接线 3：fillItineraryDraft 存为草稿后接入 saveThenAdvance，目标 套餐管理", async () => {
  const ctrip = await fs.readFile(ctripSourcePath, "utf8");
  const itinIdx = ctrip.indexOf("export async function fillItineraryDraft");
  const itinBody = ctrip.slice(itinIdx, ctrip.indexOf("async function chooseRadioValue", itinIdx));
  // 必须先调用 clickSafeSave(["存为草稿"]) 拿 savedWith，再传入 saveThenAdvance。
  assert.match(itinBody, /clickSafeSave\(page, \["存为草稿"\]\)/);
  assert.match(itinBody, /saveThenAdvance\(page, \{/);
  assert.match(itinBody, /targetTabLabels: \["套餐管理"\]/);
  // 返回契约必须仍是 { savedWith, days }
  assert.match(itinBody, /return \{ savedWith, days: product\.itinerary\.length \}/);
  assert.doesNotMatch(itinBody, /clickBasicInfoNextStep/);
});

// —— package / terms 接线：仅保存，不接入 saveThenAdvance ——
test("接线 4：fillAndSavePackage 不接入 saveThenAdvance 且只点保存", async () => {
  const ctrip = await fs.readFile(ctripSourcePath, "utf8");
  const pkgIdx = ctrip.indexOf("export async function fillAndSavePackage");
  const pkgBody = ctrip.slice(pkgIdx, ctrip.indexOf("function dateTitle", pkgIdx));
  // 套餐管理页面没有已确认的页面级「下一步」契约，本 helper 仅做安全保存。
  assert.doesNotMatch(
    pkgBody,
    /saveThenAdvance\(/,
    "fillAndSavePackage 没有已确认的页面级 Next 契约，禁止接入通用 helper",
  );
  // 必须保留保存按钮调用。
  assert.match(pkgBody, /clickSafeSave\(page, \["保存"\]\)/);
  // 必须保留注释说明「仅保存不自动推进」。
  assert.match(pkgBody, /saveThenAdvance，避免误点任何「下一步」按钮/);
});

test("接线 5：fillAndSaveTerms 不接入 saveThenAdvance，且不得触碰提审", async () => {
  const ctrip = await fs.readFile(ctripSourcePath, "utf8");
  const termsIdx = ctrip.indexOf("export async function fillAndSaveTerms");
  const termsBody = ctrip.slice(termsIdx, ctrip.indexOf("export async function ensureHotelResource", termsIdx));
  // 条款维护无页面级 Next 契约，本 helper 仅做安全保存。
  assert.doesNotMatch(
    termsBody,
    /saveThenAdvance\(/,
    "fillAndSaveTerms 没有已确认的页面级 Next 契约，禁止接入通用 helper",
  );
  // 必须保留保存按钮调用。
  assert.match(termsBody, /clickSafeSave\(page, \["保存", "保存并下一步"\]\)/);
  // 注释必须明确：本 helper 不触碰任何「提审」/「提交审核」入口。
  assert.match(termsBody, /绝不触碰任何「提审」/);
  // 实现代码（去注释后）禁止出现提审入口名。
  const codeOnly = stripComments(termsBody);
  assert.ok(!codeOnly.includes("提交审核"), "fillAndSaveTerms 不得触碰「提交审核」按钮");
  assert.ok(!codeOnly.includes("submitProductReview"), "fillAndSaveTerms 不得调用 submitProductReview");
});

// —— isProductImageTextUrl 纯函数锁 ——
test("isProductImageTextUrl / PRODUCT_IMAGE_TEXT_PATH 仍可独立 import 与真值表边界", () => {
  assert.strictEqual(PRODUCT_IMAGE_TEXT_PATH, "productImageText");
  assert.strictEqual(
    isProductImageTextUrl("https://example.com/ivbk/vendor/productImageText?productId=1"),
    true,
  );
  assert.strictEqual(
    isProductImageTextUrl("https://example.com/ivbk/vendor/productImageText/?productId=1"),
    true,
  );
  assert.strictEqual(
    isProductImageTextUrl("https://example.com/ivbk/vendor/baseInfoMerge?productId=1"),
    false,
  );
  // 必须避开无关子路径与查询串里的关键字。
  assert.strictEqual(
    isProductImageTextUrl("https://example.com/ivbk/vendor/productImageTextList?productId=1"),
    false,
  );
  assert.strictEqual(isProductImageTextUrl(""), false);
  // 非字符串输入必须降级为 false。
  assert.strictEqual(isProductImageTextUrl(null as unknown as string), false);
  assert.strictEqual(isProductImageTextUrl(undefined as unknown as string), false);
});

// —— fillAndSaveBasicInfo 仍保留 assertBasicInfoNoRedErrors 红错门禁 ——
test("fillAndSaveBasicInfo 保留 assertBasicInfoNoRedErrors 红错门禁", async () => {
  const ctrip = await fs.readFile(ctripSourcePath, "utf8");
  const body = helperBody(
    ctrip,
    "export async function fillAndSaveBasicInfo",
    "\nasync function fillRecommendationReasons",
  );
  // helper 提交成功之后必须仍调用 assertBasicInfoNoRedErrors。
  assert.match(body, /assertBasicInfoNoRedErrors\(page\)/);
  const assertBody = helperBody(
    ctrip,
    "async function assertBasicInfoNoRedErrors",
    "\nexport async function saveScreenshot",
  );
  assert.match(assertBody, /国家景区|提前预订|地接社|管家/);
});

// —— 行为级契约：通用 helper 的核心控制流锁 ——————
test("行为级契约：自动到达目标时不再点击下一步按钮", async () => {
  const ctrip = await fs.readFile(ctripSourcePath, "utf8");
  const helperStart = ctrip.indexOf("async function saveThenAdvance(");
  const helperEnd = ctrip.indexOf("async function findUnlockedSectionLabel(", helperStart);
  const helper = ctrip.slice(helperStart, helperEnd);
  // isTargetUrl(page.url()) 命中后必须直接 return { advanced, mode: "auto-navigated", savedWith }。
  assert.match(helper, /if \(isTargetUrl\(page\.url\(\)\)\) \{[\s\S]*?return \{ advanced: true, mode: "auto-navigated"/);
  // 自动跳转分支与 button.click 之间不允许出现 click / button.click（保证自动跳转不点下一步）。
  const autoIdx = helper.indexOf('mode: "auto-navigated"');
  const clickIdx = helper.indexOf("await button.click()");
  assert.ok(autoIdx > 0 && clickIdx > 0, "必须同时存在自动跳转 return 与 button.click");
  assert.ok(autoIdx < clickIdx, "自动跳转 return 必须先于 button.click（执行流顺序）");
  // button.click 必须只在「URL 未落点且 tab 未解锁」之后才出现；至少存在
  // 两处 isTargetUrl 判定：保存后立即判定 (isTargetUrl(page.url())) 与
  // 等待循环内的 (isTargetUrl(url))。
  const firstCheck = helper.indexOf("isTargetUrl");
  const lastCheck = helper.lastIndexOf("isTargetUrl");
  assert.ok(firstCheck > 0 && lastCheck > firstCheck, "saveThenAdvance 必须存在至少两处 isTargetUrl 判定");
});

test("行为级契约：未到达目标时调用 clickSafeSave 并点唯一精确「下一步」按钮", async () => {
  const ctrip = await fs.readFile(ctripSourcePath, "utf8");
  const helperStart = ctrip.indexOf("async function saveThenAdvance(");
  const helperEnd = ctrip.indexOf("async function findUnlockedSectionLabel(", helperStart);
  const helper = ctrip.slice(helperStart, helperEnd);
  // 第一步必须先 clickSafeSave(page, saveButtonNames)。
  assert.match(helper, /await clickSafeSave\(page, saveButtonNames\)/);
  // 之后才点 getByRole("button", { name: nextButtonLabel, exact: true }).
  const saveIdx = helper.indexOf("await clickSafeSave(page, saveButtonNames)");
  const roleIdx = helper.indexOf('getByRole("button", { name: nextButtonLabel, exact: true })');
  assert.ok(saveIdx > 0 && roleIdx > 0, "saveThenAdvance 必须先保存再定位按钮");
  assert.ok(saveIdx < roleIdx, "clickSafeSave 必须先于精确下一步按钮定位");
});

test("行为级契约：禁止匹配「提交审核并下一步」类提审按钮", async () => {
  const ctrip = await fs.readFile(ctripSourcePath, "utf8");
  const helperStart = ctrip.indexOf("async function saveThenAdvance(");
  const helperEnd = ctrip.indexOf("async function findUnlockedSectionLabel(", helperStart);
  const helper = stripComments(ctrip.slice(helperStart, helperEnd));
  // 精确匹配只允许 nextButtonLabel（默认「下一步」），绝不能匹配「提交审核并下一步」。
  assert.ok(!helper.includes("提交审核并下一步"));
  // 也没有任何「提交审核」相关 fallback。
  assert.ok(!helper.includes("提交审核"));
  // 严禁调用 submitCurrentSectionAndNext。
  assert.ok(!helper.includes("submitCurrentSectionAndNext"));
});

test("行为级契约：目标门禁失败错误必须包含阶段名/目标 tab/观测 URL/目标 tab", async () => {
  const ctrip = await fs.readFile(ctripSourcePath, "utf8");
  const helperStart = ctrip.indexOf("async function saveThenAdvance(");
  const helperEnd = ctrip.indexOf("async function findUnlockedSectionLabel(", helperStart);
  const helper = ctrip.slice(helperStart, helperEnd);
  // 失败错误模板：阶段点击「下一步」后未到达目标「产品图文/图文信息」：URL=…，目标 tab 仍未解锁。
  assert.match(helper, /\$\{phase\}点击「\$\{nextButtonLabel\}」后未到达目标「\$\{targetTabLabel\}」/);
  assert.match(helper, /URL=\$\{observedUrl\}/);
  assert.match(helper, /目标 tab 仍未解锁/);
});

test("行为级契约：saveThenAdvance 必须支持 auto-navigated / navigated / tabUnlocked / 失败 四种分支", async () => {
  const ctrip = await fs.readFile(ctripSourcePath, "utf8");
  const helperStart = ctrip.indexOf("async function saveThenAdvance(");
  const helperEnd = ctrip.indexOf("async function findUnlockedSectionLabel(", helperStart);
  const helper = ctrip.slice(helperStart, helperEnd);
  // 四个 mode 字符串都必须出现。
  assert.match(helper, /mode: "auto-navigated"/);
  assert.match(helper, /mode: "navigated"/);
  assert.match(helper, /mode: "tabUnlocked"/);
  // 失败分支抛错并保留阶段 / 目标 / 观测 URL / 目标 tab 上下文。
  assert.match(helper, /\$\{phase\}点击/);
  assert.match(helper, /目标 tab 仍未解锁/);
});

// —— 状态机窄修复的核心覆盖：保存后未到目标页时必须点下一步 ——————

test("状态机 1：保存后 URL 已到目标时直接 auto-navigated，不再点下一步", async () => {
  const ctrip = await fs.readFile(ctripSourcePath, "utf8");
  const helperStart = ctrip.indexOf("async function saveThenAdvance(");
  const helperEnd = ctrip.indexOf("async function findUnlockedSectionLabel(", helperStart);
  const helper = ctrip.slice(helperStart, helperEnd);
  // 保存后立即 isTargetUrl(page.url()) 命中 → return { advanced, mode: "auto-navigated" }，
  // 这条 return 必须在「规则 4 点下一步按钮」之前。
  const autoReturn = helper.indexOf('mode: "auto-navigated"');
  const buttonClick = helper.indexOf("await button.click()");
  assert.ok(autoReturn > 0, "保存后 URL 落点必须返回 auto-navigated");
  assert.ok(buttonClick > 0, "通用 helper 必须保留唯一精确「下一步」按钮点击");
  assert.ok(autoReturn < buttonClick, "auto-navigated 必须在 button.click 之前");
});

test("状态机 2：保存后目标 tab 已解锁但未激活 → 仍点下一步，不允许提前 clickSection 跳过", async () => {
  const ctrip = await fs.readFile(ctripSourcePath, "utf8");
  const helperStart = ctrip.indexOf("async function saveThenAdvance(");
  // 截到规则 4（点下一步按钮）之前这一段，作为「保存后立即判定」语义窗口。
  const nextButtonAnchor = ctrip.indexOf('getByRole("button", { name: nextButtonLabel, exact: true })', helperStart);
  const beforeNext = ctrip.slice(helperStart, nextButtonAnchor);
  // 这段窗口内只允许命中 isTargetUrl 或 findActiveTabLabel，绝不允许调
  // findUnlockedSectionLabel / clickSection。
  assert.ok(
    !beforeNext.includes("findUnlockedSectionLabel"),
    "保存后立即判定禁止调用 findUnlockedSectionLabel，否则「仅解锁」会被当作 auto-navigated",
  );
  assert.ok(
    !beforeNext.includes("clickSection"),
    "保存后立即判定禁止 clickSection，否则「仅解锁但未激活」会跳过「下一步」",
  );
  assert.ok(
    beforeNext.includes("findActiveTabLabel"),
    "保存后立即判定必须用 findActiveTabLabel 校验目标 tab 是否真正激活",
  );
});

test("状态机 3：保存后目标 tab 已激活（aria-selected/active class）→ auto-navigated，不点下一步", async () => {
  const ctrip = await fs.readFile(ctripSourcePath, "utf8");
  // findActiveTabLabel 必须存在并识别 aria-selected=true 与 ant-tabs-tab-active。
  assert.match(ctrip, /async function findActiveTabLabel\(/);
  const helper = helperBody(
    ctrip,
    "async function findActiveTabLabel(",
    "\nasync function findUnlockedSectionLabel(",
  );
  assert.match(helper, /aria-selected.*true/);
  assert.match(helper, /ant-tabs-tab-active/);
  // saveThenAdvance 内部必须调用 findActiveTabLabel，并基于其结果 return auto-navigated。
  const helperStart = ctrip.indexOf("async function saveThenAdvance(");
  const nextButtonAnchor = ctrip.indexOf('getByRole("button", { name: nextButtonLabel, exact: true })', helperStart);
  const beforeNext = ctrip.slice(helperStart, nextButtonAnchor);
  assert.match(beforeNext, /findActiveTabLabel\(/);
  // 紧跟 findActiveTabLabel 调用之后必须存在「命中即 return mode: "auto-navigated"」
  // 的分支（规则 3：保存动作把 tab 切到 active 也算自动跳转）。
  const activeCallIdx = beforeNext.indexOf("findActiveTabLabel(");
  const tail = beforeNext.slice(activeCallIdx);
  assert.match(
    tail,
    /if \(activeBeforeClick\) \{[\s\S]*?mode: "auto-navigated"/,
    "规则 3：findActiveTabLabel 命中后必须返回 auto-navigated，不点下一步",
  );
});

test("状态机 4：只允许 exact 「下一步」按钮，绝不匹配「提交审核并下一步」", async () => {
  const ctrip = await fs.readFile(ctripSourcePath, "utf8");
  const helper = stripComments(helperBody(
    ctrip,
    "async function saveThenAdvance(",
    "\nasync function findUnlockedSectionLabel(",
  ));
  // 精确定位：getByRole("button", { name: nextButtonLabel, exact: true })
  assert.match(helper, /getByRole\("button", \{ name: nextButtonLabel, exact: true \}\)/);
  // nextButtonLabel 默认值必须是「下一步」
  assert.match(helper, /nextButtonLabel = "下一步"/);
  // 注释/实现都不允许出现「提交审核并下一步」或「提交审核」字样
  assert.ok(!helper.includes("提交审核"), "saveThenAdvance 不允许出现「提交审核」任何变体");
  // 也禁止调用 submitCurrentSectionAndNext
  assert.ok(!helper.includes("submitCurrentSectionAndNext"), "saveThenAdvance 禁止调用 submitCurrentSectionAndNext");
});

test("状态机 5：presentation / itinerary 走同一通用 helper，禁止中文 tab 名伪 URL 判断", async () => {
  const ctrip = await fs.readFile(ctripSourcePath, "utf8");
  // presentation
  const presIdx = ctrip.indexOf("export async function fillAndSavePresentation");
  const presBody = ctrip.slice(presIdx, ctrip.indexOf("function dayScopeFor", presIdx));
  assert.match(presBody, /saveThenAdvance\(page, \{/);
  // presentation 的 isTargetUrl 不允许再用 /行程描述/.test(url) 这种中文伪判断。
  // 允许用「URL 段已离开 productImageText」或「URL 不再属于 baseInfoMerge」
  // 这类真实路径段判断；至少不能让中文 tab 名直接出现在 isTargetUrl 实现里。
  assert.ok(
    !/isTargetUrl:\s*\(\s*url\s*\)\s*=>\s*[^,]*\/行程描述\//.test(presBody),
    "fillAndSavePresentation 禁止把中文「行程描述」当作 URL 命中条件",
  );
  // itinerary
  const itinIdx = ctrip.indexOf("export async function fillItineraryDraft");
  const itinBody = ctrip.slice(itinIdx, ctrip.indexOf("async function chooseRadioValue", itinIdx));
  assert.match(itinBody, /saveThenAdvance\(page, \{/);
  assert.ok(
    !/isTargetUrl:\s*\(\s*url\s*\)\s*=>\s*[^,]*\/套餐管理\//.test(itinBody),
    "fillItineraryDraft 禁止把中文「套餐管理」当作 URL 命中条件",
  );
});

// 行程描述 → 套餐管理 的真实自动跳转证据是目标「套餐管理」tab 的
// aria-selected=true（顶层 tab role=tab 的属性）。当前 `fillItineraryDraft`
// 阶段 URL 可能不含 baseInfoMerge 段（例如独立 itinerary 页），旧「URL 不再
// 属于 baseInfoMerge」的反向判断会在每次保存后立刻误判 auto-navigated 并
// 跳过点下一步，必须改回「永不自行判定 URL 命中」。本测试锁死源码契约，防
// 回归。
test("状态机 5.5：fillItineraryDraft 的 isTargetUrl 不依赖 URL 片段（永不自行判定）", async () => {
  const ctrip = await fs.readFile(ctripSourcePath, "utf8");
  const itinIdx = ctrip.indexOf("export async function fillItineraryDraft");
  const itinBody = ctrip.slice(itinIdx, ctrip.indexOf("async function chooseRadioValue", itinIdx));

  // 必须在 saveThenAdvance 调用块里出现 `isTargetUrl: () => false`，这是
  // 既能通过 TS 类型「(url: string) => boolean」、又能完全脱离 URL 路径段的
  // 唯一契约形式：参数声明 + 显式 false 短函数体。
  assert.match(
    itinBody,
    /isTargetUrl:\s*\(\s*\)\s*=>\s*false\b/,
    "fillItineraryDraft 必须把 isTargetUrl 写成「() => false」，自动跳转证据由目标「套餐管理」tab active 判定",
  );

  // 任何尝试恢复成「URL 包含某路径段」或「URL 排除某路径段」（中文 tab
  // 名或英文路径段）都会因这段源码契约而回归。下面这条正向断言防住「留
  // baseInfoMerge 兜底」的具体回归路径：之前的实现是
  //   (url) => typeof url === "string" && !/baseInfoMerge/.test(url)
  // 必须不存在——它会让 itinerary 独立页面的 URL 在保存后被立刻误判为
  // auto-navigated，跳过点下一步。
  assert.doesNotMatch(
    itinBody,
    /isTargetUrl:\s*\([^)]*\)\s*=>[\s\S]*?baseInfoMerge/,
    "fillItineraryDraft 的 isTargetUrl 禁止使用 baseInfoMerge 段兜底，否则 itinerary 独立页 URL 会误判 auto-navigated",
  );

  // 同样禁止恢复成「URL 不再属于 productImageText / 包车描述 / 推荐语 / 套餐管理」等任何路径段判断，回归源不可出现。
  assert.doesNotMatch(
    itinBody,
    /isTargetUrl:\s*\([^)]*\)\s*=>[\s\S]*?(productImageText|行程描述|套餐管理)/,
    "fillItineraryDraft 的 isTargetUrl 禁止依赖 productImageText / 中文 tab 名做 URL 命中判断",
  );

  // 防「fetch-first baseInfoMerge 兑底未覆盖到的中间形态」：除上面「() => false」外，
  // isTargetUrl 整个字段不允许是「带参数的箭头函数」（任何「url =>」或 「(url) =>」
  // 形式都不允许），强制 must be () => false。
  assert.doesNotMatch(
    itinBody,
    /isTargetUrl:\s*\(\s*url\s*\)\s*=>|isTargetUrl:\s*url\s*=>/,
    "fillItineraryDraft 的 isTargetUrl 必须是「() => false」，禁止接收 url 形参再自定义返回",
  );
});

test("状态机 6：package / terms 不接入通用 helper，不碰提审/发布/价格", async () => {
  const ctrip = await fs.readFile(ctripSourcePath, "utf8");
  // package
  const pkgIdx = ctrip.indexOf("export async function fillAndSavePackage");
  const pkgBody = ctrip.slice(pkgIdx, ctrip.indexOf("function dateTitle", pkgIdx));
  assert.doesNotMatch(pkgBody, /saveThenAdvance\(/);
  assert.match(pkgBody, /clickSafeSave\(page, \["保存"\]\)/);
  // terms
  const termsIdx = ctrip.indexOf("export async function fillAndSaveTerms");
  const termsBody = ctrip.slice(termsIdx, ctrip.indexOf("export async function ensureHotelResource", termsIdx));
  assert.doesNotMatch(termsBody, /saveThenAdvance\(/);
  assert.match(termsBody, /clickSafeSave\(page, \["保存", "保存并下一步"\]\)/);
  const termsCode = stripComments(termsBody);
  assert.ok(!termsCode.includes("提交审核"), "fillAndSaveTerms 禁止触碰「提交审核」");
  assert.ok(!termsCode.includes("submitProductReview"), "fillAndSaveTerms 禁止调用 submitProductReview");
});

test("状态机 7：点击下一步后等待门禁允许 tabUnlocked 分支（已解锁未激活时安全 clickSection 落点）", async () => {
  const ctrip = await fs.readFile(ctripSourcePath, "utf8");
  const helper = helperBody(
    ctrip,
    "async function saveThenAdvance(",
    "\nasync function findUnlockedSectionLabel(",
  );
  // 点完下一步后的等待循环里，必须先判 isTargetUrl，再判 findActiveTabLabel，
  // 再判 findUnlockedSectionLabel（fallback）；循环结束后若仍未命中 navigated，
  // 才允许「已解锁 → clickSection → tabUnlocked」分支。
  const buttonClick = helper.indexOf("await button.click()");
  assert.ok(buttonClick > 0, "必须存在 button.click()");
  const tail = helper.slice(buttonClick);
  const activeIdx = tail.indexOf("findActiveTabLabel");
  const unlockedIdx = tail.indexOf("findUnlockedSectionLabel");
  const tabUnlockedMode = tail.indexOf('mode: "tabUnlocked"');
  assert.ok(activeIdx > 0, "点完下一步后必须用 findActiveTabLabel 检测目标 tab 激活");
  assert.ok(unlockedIdx > 0, "点完下一步后仍允许用 findUnlockedSectionLabel 检测已解锁");
  assert.ok(activeIdx < unlockedIdx, "findActiveTabLabel 必须先于 findUnlockedSectionLabel");
  assert.ok(tabUnlockedMode > 0, "点完下一步后允许返回 tabUnlocked");
});

test("状态机 8：失败门禁错误必须明确包含阶段名 / 目标 tab / 观测 URL / 未到达目标 tab", async () => {
  const ctrip = await fs.readFile(ctripSourcePath, "utf8");
  const helper = helperBody(
    ctrip,
    "async function saveThenAdvance(",
    "\nasync function findUnlockedSectionLabel(",
  );
  assert.match(helper, /\$\{phase\}点击「\$\{nextButtonLabel\}」后未到达目标「\$\{targetTabLabel\}」/);
  assert.match(helper, /URL=\$\{observedUrl\}/);
  assert.match(helper, /目标 tab 仍未解锁/);
});

test("状态机 9：saveThenAdvance 不触碰任何提审/发布/上架/价格库存动作", async () => {
  const ctrip = await fs.readFile(ctripSourcePath, "utf8");
  const helper = stripComments(helperBody(
    ctrip,
    "async function saveThenAdvance(",
    "\nasync function findUnlockedSectionLabel(",
  ));
  const blacklist = [
    "提交审核",
    "批量上线",
    "设为有效",
    "价格库存",
    "priceInventory",
    "fillAndSubmitPricingInventory",
    "publishProduct",
    "submitProductReview",
  ];
  for (const term of blacklist) {
    assert.ok(!helper.includes(term), `saveThenAdvance 禁止涉及 basic 以外动作：${term}`);
  }
});

test("状态机 10：presentation / itinerary 不调用 submitCurrentSectionAndNext；itinerary 阶段允许 nextButtonLabel=「提交审核并下一步」以适配 VBK tourdays 页", async () => {
  const ctrip = await fs.readFile(ctripSourcePath, "utf8");
  const presIdx = ctrip.indexOf("export async function fillAndSavePresentation");
  const presBody = stripComments(ctrip.slice(presIdx, ctrip.indexOf("function dayScopeFor", presIdx)));
  const itinIdx = ctrip.indexOf("export async function fillItineraryDraft");
  const itinBody = stripComments(ctrip.slice(itinIdx, ctrip.indexOf("async function chooseRadioValue", itinIdx)));
  assert.ok(!presBody.includes("提交审核并下一步"), "fillAndSavePresentation 禁止匹配「提交审核并下一步」");
  assert.ok(!presBody.includes("submitCurrentSectionAndNext"), "fillAndSavePresentation 禁止调用 submitCurrentSectionAndNext");
  assert.ok(!itinBody.includes("submitCurrentSectionAndNext"), "fillItineraryDraft 禁止调用 submitCurrentSectionAndNext");
  // VBK 行程描述页（tourdays）的唯一推进按钮是「提交审核并下一步」，
  // 这个按钮在 itinerary 阶段只是保存并切换到下一 tab，不会真正提交产品。
  // 因此允许 fillItineraryDraft 显式传 nextButtonLabel: "提交审核并下一步"。
  assert.ok(itinBody.includes("nextButtonLabel: \"提交审核并下一步\""), "fillItineraryDraft 应使用 nextButtonLabel: \"提交审核并下一步\"");
});

test("matchDropdownOption「唯一可用项」直接选，不依赖精确也不依赖 AI", async () => {
  const { matchDropdownOption } = await import("../src/main/automation/dropdown-match.js");

  // 1. 唯一可用项（去除 Not Found 这种装饰文案）
  const r1 = await matchDropdownOption(
    [{ text: "Not Found" }, { text: "大同站" }, { text: "" }],
    [false, false, false],
    ["大同"],
    { kind: "station", desired: "大同", product: {}, description: "接送站" },
    null,
  );
  assert.deepEqual(r1, { index: 1, text: "大同站", source: "single" }, "唯一可用项必须被直接选中");

  // 2. 零可用项 → null
  const r2 = await matchDropdownOption(
    [{ text: "Not Found" }, { text: "" }],
    [false, false],
    ["大同"],
    { kind: "station", desired: "大同", product: {}, description: "接送站" },
    null,
  );
  assert.equal(r2, null, "无可用项必须返回 null");

  // 3. 多项 + aliases 命中 → exact
  const r3 = await matchDropdownOption(
    [{ text: "大同站" }, { text: "大同南站" }, { text: "大同北站" }],
    [false, false, false],
    ["大同站", "大同", "大同南站"],
    { kind: "station", desired: "大同", product: {}, description: "接送站" },
    null,
  );
  assert.deepEqual(r3, { index: 0, text: "大同站", source: "exact" }, "aliases 命中应走 exact");

  // 4. 多项 + aliases 未命中 + 有 AI → AI 兜底
  let aiCalled = false;
  const fakeAi = async (input: { kind: string; desired: string; candidates: Array<{ text: string }> }) => {
    aiCalled = true;
    return { pickedText: input.candidates[1].text, reasoning: "mock" };
  };
  const r4 = await matchDropdownOption(
    [{ text: "云冈机场" }, { text: "大同站" }, { text: "云冈石窟" }],
    [false, false, false],
    ["大同"],
    { kind: "station", desired: "大同", product: {}, description: "接送站" },
    fakeAi,
  );
  assert.ok(aiCalled, "多项未命中应调 AI");
  assert.deepEqual(r4, { index: 1, text: "大同站", source: "ai", reasoning: "mock" }, "AI 选中应返回 ai 源");

  // 5. 多项 + 仅有境外项 → AI 候选为空 → null（不让 AI 误中境外）
  const r5 = await matchDropdownOption(
    [{ text: "朝鲜-大同" }, { text: "韩国-大同" }],
    [false, false],
    ["大同"],
    { kind: "station", desired: "大同", product: {}, description: "接送站" },
    async () => ({ pickedText: "朝鲜-大同", reasoning: "should not be called" }),
  );
  assert.equal(r5, null, "仅有境外项时不允许返回任何选项");

  // 6. AI 抛错 → null（不拖崩上游）
  const r6 = await matchDropdownOption(
    [{ text: "云冈机场" }, { text: "云冈石窟" }],
    [false, false],
    ["大同"],
    { kind: "station", desired: "大同", product: {}, description: "接送站" },
    async () => { throw new Error("network down"); },
  );
  assert.equal(r6, null, "AI 异常必须降级为 null");

  // 7. disabled 唯一项不能被选中（避免误中「不可用」项）
  const r7 = await matchDropdownOption(
    [{ text: "大同站" }],
    [true],
    ["大同"],
    { kind: "station", desired: "大同", product: {}, description: "接送站" },
    null,
  );
  assert.equal(r7, null, "唯一项被 disabled 时不能返回");
});
test("closeBlockingDialogs / safeClick helper 已在 ctrip.ts 中定义", async () => {
  const source = await fs.readFile(ctripSourcePath, "utf8");
  // 通用 helper：扫页面上所有挡路弹窗并关掉，供 safeClick 在 click 失败后自愈。
  assert.match(source, /async function closeBlockingDialogs\(/);
  assert.match(source, /\.ant-modal-wrap:not\(\.ant-modal-wrap-hidden\) \.ant-modal/);
  assert.match(source, /\.ant-drawer-open \.ant-drawer-content/);
  assert.match(source, /Escape/);
  // safeClick：先尝试点，失败再关弹窗重试（不要在点之前关，会把刚开的弹窗关掉）。
  assert.match(source, /async function safeClick\(/);
  assert.match(source, /closeBlockingDialogs\(page\)\.catch\(\(\) => false\)/);
  // selectStationAddress 必须用上 safeClick 点接送站输入框与确定按钮。
  assert.match(source, /await safeClick\(page, confirm, \{ force: true \}\)/);
  assert.match(source, /await safeClick\(page, addressInput\.first\(\)\)/);
  // 【重要】selectStationAddress 运行在接送站弹窗内部，不能调
  // closeBlockingDialogs。closeBlockingDialogs 会把 role=dialog 的弹窗
  // 自己都关掉（包括接送站），让后续 click 超时。锁定该项设计：函数体内
  // 不允许再调 closeBlockingDialogs。锁定方式：去掉注释后检索「closeBlockingDialogs」
  // 必须为 0。
  const fnStart = source.indexOf("export async function selectStationAddress");
  const fnEnd = source.indexOf("\nasync function fillPickupAndDropoff", fnStart);
  assert.ok(fnStart >= 0 && fnEnd > fnStart, "selectStationAddress 区间定位失败");
  // 去掉所有行注释再检索：单行 // 整行去掉
  const fnBodyNoComments = source
    .slice(fnStart, fnEnd)
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//") && !line.trimStart().startsWith("*"))
    .join("\n");
  assert.equal(
    (fnBodyNoComments.match(/closeBlockingDialogs/g) || []).length,
    0,
    "selectStationAddress 内部不允许再调 closeBlockingDialogs（会自关接送站弹窗）",
  );
  // 退路为 collapseOverlayTooltips（Escape）。
  assert.match(fnBodyNoComments, /collapseOverlayTooltips/);
});
