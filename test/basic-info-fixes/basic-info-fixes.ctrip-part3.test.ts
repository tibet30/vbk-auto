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

test("saveThenAdvance 不做任何提审、发布、上架、库存、价格动作", async () => {
  const ctrip = readCtripSource();
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
  const ctrip = readCtripSource();
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
  const ctrip = readCtripSource();
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
  assert.match(presBody, /buildRecommendationReasonsPlan\(presentation\.recommendations\)/,
    "进入产品图文前必须校验完整的三条推荐理由配置");
  assert.match(presBody, /cover\.source !== "ctripLibrary"/, "产品图文必须在写入前校验完整的图库封面配置");
  assert.match(presBody, /Number\.isInteger\(cover\.imageId\)/, "封面必须有已选图库图片的有效身份");
  assert.match(presBody, /await fillRecommendationReasons\(page, recommendations\)/,
    "产品图文必须实际填写已校验的推荐理由");
  assert.match(presBody, /await selectCtripLibraryCover\(page, presentation\.cover\)/,
    "产品图文必须录入图库封面");
  assert.match(
    presBody,
    /if \(!filledFeatures\)/,
    "产品特点输入框缺失时必须存在 if (!filledFeatures) 分支",
  );
  assert.match(
    presBody,
    /找不到产品特点富文本输入框/,
    "产品特点输入框缺失时抛错必须保留「找不到产品特点富文本输入框」前缀",
  );
});

test("接线 3：fillItineraryDraft 存为草稿后接入 saveThenAdvance，目标 套餐管理", async () => {
  const ctrip = readCtripSource();
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
  const ctrip = readCtripSource();
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
  const ctrip = readCtripSource();
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
  const ctrip = readCtripSource();
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
  const ctrip = readCtripSource();
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
  const ctrip = readCtripSource();
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
  const ctrip = readCtripSource();
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
  const ctrip = readCtripSource();
  const helperStart = ctrip.indexOf("async function saveThenAdvance(");
  const helperEnd = ctrip.indexOf("async function findUnlockedSectionLabel(", helperStart);
  const helper = ctrip.slice(helperStart, helperEnd);
  // 失败错误模板：阶段点击「下一步」后未到达目标「产品图文/图文信息」：URL=…，目标 tab 仍未解锁。
  assert.match(helper, /\$\{phase\}点击「\$\{nextButtonLabel\}」后未到达目标「\$\{targetTabLabel\}」/);
  assert.match(helper, /URL=\$\{observedUrl\}/);
  assert.match(helper, /目标 tab 仍未解锁/);
});

test("行为级契约：saveThenAdvance 必须支持 auto-navigated / navigated / tabUnlocked / 失败 四种分支", async () => {
  const ctrip = readCtripSource();
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
  const ctrip = readCtripSource();
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
  const ctrip = readCtripSource();
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
  const ctrip = readCtripSource();
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
