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

test("状态机 4：只允许 exact 「下一步」按钮，绝不匹配「提交审核并下一步」", async () => {
  const ctrip = readCtripSource();
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
  const ctrip = readCtripSource();
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
  const ctrip = readCtripSource();
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
  const ctrip = readCtripSource();
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
  const ctrip = readCtripSource();
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
  const ctrip = readCtripSource();
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
  const ctrip = readCtripSource();
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
  const ctrip = readCtripSource();
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
  const { matchDropdownOption } = await import("../../src/main/automation/dropdown-match.js");

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
  const source = readCtripSource();
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
