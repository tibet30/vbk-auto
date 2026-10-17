import path from "node:path";
import { fileURLToPath } from "node:url";
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
  readAutomationFile,
  readCtripSource,
  resolveAdvanceBooking,
  shouldRefillBasicInfo,
  stripComments,
  test,
} from "./basic-info-fixes.shared.js";

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

test("阶段重试共用 API 执行器，不由入口重新打开编辑页", () => {
  for (const file of ["automation.main/automation.main.run.ts", "automation.main/automation.main.run-one.ts"]) {
    const runner = readAutomationFile(file);
    assert.match(runner, /buildBasicExecute\(ctx/);
    assert.doesNotMatch(runner, /openProductEditor\(|fillAndSaveBasicInfo\(/);
  }
  assert.match(readAutomationFile("automation.main/runtime/basic.ts"), /await ensureBasicInfoApi\(/);
});

test("retryFrom>0 保留恢复日志并由共享阶段执行链导航", () => {
  const runner = readAutomationFile("automation.main/automation.main.run.ts");
  assert.match(runner, /已从 \$\{retryFrom\} 阶段继续录入（通过 API 保存并回读）/);
  assert.doesNotMatch(runner, /openProductEditor\(|fillAndSaveBasicInfo\(/);
  assert.match(runner, /index = setup\.startIndex/);
  assert.equal(runner.match(/basic: buildBasicExecute\(ctx, setup, productIdRef\)/g)?.length, 1);
  assert.equal(runner.match(/await recoverDraftPhase\(/g)?.length, 1, "统一循环每阶段只有一个恢复入口");
  assert.match(runner, /needs_user/);
  assert.match(runner, /产品 ID 缺失，无法继续后续阶段/);
  const phase = readAutomationFile("automation.main/runtime/phase.ts");
  assert.match(phase, /executeApiWithPhasePageSync\(/);
  assert.match(phase, /runDraftPhaseWithRecovery\(/);
});

test("共享 basic 执行器在每次 API 尝试前清空 scenicSpotLogs", () => {
  const basic = readAutomationFile("automation.main/runtime/basic.ts");
  const execute = basic.indexOf('executeDraftPhase(');
  const clear = basic.indexOf('scenicSpotLogs.length = 0');
  const refill = basic.indexOf('const shouldRefill = shouldRefillBasicInfo(');
  assert.ok(execute >= 0 && clear > execute && refill > clear);
});

test("基本信息文案修复持久化实际传给保存 API 的产品对象", () => {
  const basic = readAutomationFile("automation.main/runtime/basic.ts");
  assert.match(basic, /product: productPayload,[\s\S]*?persist: \(\) => \{\s*productDetail\.product = productPayload/);
});

test("非 Agent basic 已保存且数据完整时保留跳过重复填充的条件", () => {
  const basic = readAutomationFile("automation.main/runtime/basic.ts");
  assert.match(basic, /!ctx\.agentControlled && shouldRefill\.reason === "complete"/);
  assert.match(basic, /basic 阶段已保存且产品数据完整，跳过重复填充/);
  assert.match(basic, /executeDraftPhase\([\s\S]*"basic"/);
  assert.match(readAutomationFile("automation.main/automation.main.retry-navigation.ts"), /await refreshPhasePageAfterApi\(/);
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

test("findButlerOptionIndex VBK 退化下拉（整列无 value）按 displayName 回退", () => {
  // VBK 退化下拉：整列都未提供 value（退化场景），此时按 displayName
  // 回退是合理且安全的（VBK 没给 ID，我们只能按姓名选）。新安全契约
  // 只在 VBK 提供了非空 value 时禁用 byName 回退；本测试仅锁定
  // 「全空 value」时的退化行为，不再触碰非空 ID 共存的旧断言。
  const index = findButlerOptionIndex(
    [
      { value: "", label: "客服A" },
      { value: "", label: "客服B" },
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

// —— VBK 下拉中无目标联系人时的「证据充分」红线 ——
// 联系人匹配必须严格按 ID 或精确姓名匹配，不允许任何形式的隐式回退；
// 否则 basic 阶段会把第一个看似像的联系人盲选，把产品方案与实际携程草稿
// 负责人错绑，触发更大面积的核对工作。
test("findButlerOptionIndex 下拉完全无匹配时返回 -1，不做隐式回退", () => {
  const index = findButlerOptionIndex(
    [
      { value: "1001", label: "李四 lisi@qq.com +86 13800000000" },
      { value: "1002", label: "王五 wangwu@qq.com +86 13900000000" },
    ],
    { contactCardId: 1368298, displayName: "安思科" },
  );
  assert.equal(index, -1);
});

test("findButlerOptionIndex VBK 退化下拉（同姓名另一张卡）不让 byName 误选", () => {
  // 「证据充分」红线：虽然 byName 回退逻辑里区分了「安思科-国际」与
  // 「安思科」（分隔符必须是空白），但只要 VBK 提供了非空 value（说明
  // 它知道 contactCardId），就不应该落到 byName 回退——否则会把
  // 「ID 已删除但同姓名仍存在」的另一张卡误选。
  // 本测试锁死安全门：hasAnyValue 命中即 -1，绝不 byName 回退。
  const index = findButlerOptionIndex(
    [
      { value: "1001", label: "李四 lisi@qq.com +86 13800000000" },
      { value: "1002", label: "安思科-国际 ansike@qq.com +86 18835112829" },
    ],
    { contactCardId: 1368298, displayName: "安思科" },
  );
  assert.equal(index, -1, "VBK 提供非空 value 时 byName 必须被禁用");
});

test("fillButlerContact 错误信息包含可操作的修复提示", async () => {
  // 当管家联系人在 VBK 下拉里完全找不到时，错误信息必须：
  //   1) 说明是哪个联系人缺失（含 ID + 姓名）；
  //   2) 明确给出修复路径（在 VBK 维护 / 更新账号固定信息）；
  //   3) 不混淆使用「可选」列表 —— 那些候选都不是同一个联系人。
  const source = readCtripSource();
  const start = source.indexOf("async function fillButlerContact");
  assert.ok(start >= 0, "找不到 fillButlerContact 定义");
  const rest = source.slice(start);
  const end = rest.indexOf("\nasync function ", 1);
  const body = end >= 0 ? rest.slice(0, end) : rest;
  assert.match(body, /不在 VBK 联系人下拉中/, "fillButlerContact 必须说明联系人不在下拉中");
  assert.match(body, /请在 VBK 维护该联系人或更新账号固定信息/, "fillButlerContact 必须给出可操作的修复提示");
  assert.match(body, /可选：/, "fillButlerContact 仍附带候选列表供运营排查");
});
const ctripSourcePath = path.resolve(here, "..", "src", "main", "automation", "ctrip.ts");
