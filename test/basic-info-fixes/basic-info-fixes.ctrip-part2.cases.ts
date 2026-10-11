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

test("fillServicePhone 存在且严格精确匹配、不默认第一项", async () => {
  const source = readCtripSource();
  assert.match(source, /async function fillServicePhone\(/);
  // 禁止 .first() / .nth(0) 逃避，必须用严格相等的精确匹配。
  const start = source.indexOf("async function fillServicePhone(");
  assert.ok(start >= 0, "找不到 fillServicePhone 定义");
  const rest = source.slice(start);
  const end = rest.indexOf("\nasync function ", 1);
  const body = end >= 0 ? rest.slice(0, end) : rest;
  assert.match(body, /label\[for=\\"baseInfo\.phone400\\"\]/, "必须使用 VBK 真实的 400 电话字段 ID");
  assert.ok(/text === target/.test(body), "fillServicePhone 必须用严格相等精确匹配");
  assert.match(body, /BASIC_INFO_SEARCH_TIMEOUT_MS/,
    "fillServicePhone 未命中前必须完成有界搜索窗口");
  const clickTrigger = body.indexOf("await trigger.click()");
  const settle = body.indexOf("await delay(SERVICE_PHONE_POLL_INTERVAL_MS)");
  const collect = body.indexOf("await readLocatorSnapshot(options)");
  assert.ok(clickTrigger >= 0 && settle > clickTrigger && collect > settle,
    "400 电话必须先展开下拉，按退避时间等待后再读取候选项");
  assert.match(source, /BASIC_INFO_SEARCH_TIMEOUT_MS\s*=\s*3_000/);
  assert.match(source, /SERVICE_PHONE_POLL_INTERVAL_MS\s*=\s*150/);
  assert.match(body, /throw new NonAdvisableAutomationError/,
    "400 电话未命中必须标记为禁止 AI 诊断的确定性错误");
  // 在「收集选项文本」之后到「点选」之前，禁掉任何 .first()/.nth(0) 偷懒写法。
  const collectAnchor = body.indexOf("await readLocatorSnapshot(options)");
  assert.ok(collectAnchor > 0, "找不到 fillServicePhone 的选项收集调用");
  const clickAnchor = body.indexOf("await clickLocatorSnapshotOption(options, snapshot[matchIndex])");
  assert.ok(clickAnchor > collectAnchor, "找不到 fillServicePhone 的原子精确点击");
  const region = body.slice(collectAnchor, clickAnchor);
  assert.ok(!/\.first\(/.test(region), "fillServicePhone 在收集-点选之间出现 .first()");
  assert.ok(!/\.nth\(0\)/.test(region), "fillServicePhone 在收集-点选之间出现 .nth(0)");
});

test("fillServicePhone 在 3 秒窗口内持续轮询，可选中晚到的账号号码", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <div class="ant-form">
        <div class="ant-form-item">
          <label for="baseInfo.phone400">线上 400 电话</label>
          <div class="ant-select-selection" role="combobox" aria-controls="phone-options">请选择</div>
        </div>
      </div>
      <div id="phone-options" class="ant-select-dropdown"></div>
      <script>
        window.phoneTiming = {};
        document.querySelector('[role="combobox"]').addEventListener('click', () => {
          window.phoneTiming.openedAt = performance.now();
          setTimeout(() => {
            const option = document.createElement('div');
            option.className = 'ant-select-item-option';
            option.textContent = '0609240';
            option.addEventListener('click', () => {
              window.phoneTiming.selectedAt = performance.now();
            });
            document.querySelector('#phone-options').appendChild(option);
          }, 1_200);
        });
      </script>
    `);
    await fillServicePhone(page, "0609240");
    const timing = await page.evaluate(() => (window as any).phoneTiming as { openedAt: number; selectedAt: number });
    assert.ok(timing.selectedAt - timing.openedAt >= 1_150,
      `候选选择过早：${timing.selectedAt - timing.openedAt}ms`);
  } finally {
    await browser.close();
  }
});

test("fillScenicAreaSpots 存在并以严格相等匹配、不默认第一项", async () => {
  const source = await fs.readFile(new URL("../../src/main/automation/ctrip/basic-info/scenic/spots.ts", import.meta.url), "utf8");
  const body = helperBody(source, "export async function fillScenicAreaSpots(", "\nexport async function _scenicSliceAnchor");
  assert.match(body, /chooseExact\(comboboxes\.nth\(3\), spot/);
  assert.match(body, /chooseExact\(comboboxes\.nth\(2\), spot/);
  assert.match(body, /aliases\.includes\(text\)/, "fillScenicAreaSpots 必须用可控别名精确匹配");
  assert.match(body, /readLocatorSnapshot\(options\)/);
  assert.match(body, /景点[“"]\$\{spot\}[”"]已选择但未成功添加/);
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
  const source = readCtripSource();
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

test("pickCityOption 指定中国时唯一裸城市名也允许命中，避免不必要等待", () => {
  const result = pickCityOption(["太原"], "太原", "中国");
  assert.equal(result.kind, "matched");
  assert.equal(result.kind === "matched" && result.label, "太原");
});

test("pickCityOption 识别 VBK 拼接的城市与省份两列，避免误走 AI 消歧", () => {
  const result = pickCityOption(["中国-西安中国-陕西"], "西安", "中国");
  assert.equal(result.kind, "matched");
  assert.equal(result.kind === "matched" && result.index, 0);
});

test("pickCityOption 不把同名前缀的其它城市误判为精确城市", () => {
  const result = pickCityOption(["中国-西安郊区"], "西安", "中国");
  assert.equal(result.kind, "missing");
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
  const source = readCtripSource();
  const start = source.indexOf("async function fillCitySelect");
  const end = source.indexOf("\nexport async function openProductEditor", start);
  const body = source.slice(start, end);
  // 幂等判断那一步必须把 selectedText 包进数组喂给 pickCityOption，且带上
  // preferredCountry；缺一会让 endsWith 旧逻辑残留。
  assert.match(body, /pickCityOption\(\[selectedText\], city, preferredCountry\)/);
  assert.ok(!/selectedText\.endsWith/.test(body), "幂等分支不能再用 endsWith 直接命中");
});

test("fillBasicInfo 在省份非空时给两处城市都传中国，且 fallback 行为受控", async () => {
  const source = readCtripSource();
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

import "./basic-info-fixes.ctrip-navigation.cases.js";
