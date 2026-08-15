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

test("阶段重试会在当前页面继续，openProductEditor 带 stayOnCurrentTab 不拽回基本信息", async () => {
  const source = readAutomationSource();
  const ctripSource = readCtripSource();

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
  // 旧实现需要先点国家框，再点省份框；当前 VBK 国内省份接口可直接在
  // 第二个级联框搜索，测试只锁定直接省份搜索与 Not Found 过滤。
  assert.match(ctripSource, /await comboboxes\.nth\(1\)\.click\(\)/);
  assert.match(ctripSource, /provinceSearch\.fill\(label/);
  assert.match(ctripSource, /text !== "Not Found"/);
});

test("retryFrom>0 也由 basic runner 包裹，else 不再直接 fillAndSaveBasicInfo/setBasicInfoSaved", async () => {
  // 锁死行为：retryFrom>0 分支只做 openProductEditor（带 stayOnCurrentTab）
  // + 精确日志，不允许在 else 块里直接调用 fillAndSaveBasicInfo 或
  // setBasicInfoSaved，也不允许写 basicInfoSaved = true；真正的 basic
  // 填写统一交给下方 runPhaseWithRecovery(makeCtx("basic", basicExecute, 0))
  // 这一处。
  const source = readAutomationSource();

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
  const source = readAutomationSource();
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

test("全量 runner 在 basic 已保存且产品完整时跳过重复填充", () => {
  const source = readAutomationSource();
  const start = source.indexOf("const basicExecute = async () =>");
  const body = source.slice(start, source.indexOf("const handlers:", start));
  assert.match(body, /shouldRefill\.reason === "complete"/);
  assert.match(body, /basic 阶段已保存且产品数据完整，跳过重复填充/);
  assert.match(body, /run\.phases\[0\]\.status = "completed";\s*return;/);
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
