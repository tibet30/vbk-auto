// 集成测试：直接调 selectStationAddress 跑 fixture/station-picker.html
// 验证修复后 indexes (0, 1) + 不再调 closeBlockingDialogs + AI 兜底路径
// 都能正确填机场 + 火车站。
import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function loadFixture() {
  const ctripMod = await import(
    new URL("../../src/main/automation/ctrip/ctrip.ts", import.meta.url).href
  );
  const stationsMod = await import(
    new URL("../../src/main/automation/ctrip/itinerary/stations.ts", import.meta.url).href
  );
  const { selectStationAddress } = ctripMod;
  const { handleAirportTrainModal } = stationsMod;
  if (typeof selectStationAddress !== "function") {
    throw new Error("selectStationAddress not exported");
  }
  if (typeof handleAirportTrainModal !== "function") {
    throw new Error("handleAirportTrainModal not exported");
  }
  return { selectStationAddress, handleAirportTrainModal };
}

test("selectStationAddress 单一机场项 + 精确火车项", async () => {
  const { selectStationAddress } = await loadFixture();
  const b = await chromium.launch({ headless: true });
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await ctx.newPage();
  await p.goto("file://" + path.join(__dirname, "../../fixtures/station-picker.html"), {
    waitUntil: "domcontentloaded",
  });
  await p.waitForTimeout(300);

  // 校验弹窗初始 DOM 契约：只有 2 个 input
  const before = await p.evaluate(() => {
    const dlg = document.querySelector('[data-testid="station-dialog"]');
    return {
      dlgVisible: dlg?.style.display !== "none",
      inputCount: dlg?.querySelectorAll("input").length || 0,
    };
  });
  assert.equal(before.inputCount, 2, "弹窗必须只有 2 个 input（airport=0, train=1）");
  assert.equal(before.dlgVisible, false, "弹窗初始不可见");

  const card = p.locator("td-day-card");
  await selectStationAddress(p, card, "大同");

  const after = await p.evaluate(() => {
    const inp = document.querySelector('[data-testid="station-input"]');
    return inp?.value || "";
  });
  assert.equal(after, "大同云冈国际机场、大同", `期望「大同云冈国际机场、大同」，实际「${after}」`);

  await b.close();
});

test("selectStationAddress 多项 + AI 兜底：airport AI 选第 2 项、train 精确命中", async () => {
  const { selectStationAddress } = await loadFixture();
  const b = await chromium.launch({ headless: true });
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await ctx.newPage();
  await p.goto("file://" + path.join(__dirname, "../../fixtures/station-picker.html"), {
    waitUntil: "domcontentloaded",
  });
  await p.waitForTimeout(300);

  // 注入多候选项：city=运城 → airport 3 项（无「运城」精确）、train 5 项（含「运城」精确）
  await p.evaluate(() => {
    window.STATION_DB.airport["运城"] = ["运城机场", "运城关公机场", "运城盐湖机场"];
    window.STATION_DB.train["运城"] = ["运城南", "运城北", "运城东", "运城西", "运城"];
  });

  // disambiguator 签名是生产路径的对象式请求：{ kind, stationSubtype, candidates, ... }。
  const disambiguator = async (request) => {
    if (request.kind === "station" && request.stationSubtype === "airport") {
      return { pickedText: request.candidates[1].text, reasoning: "test-AI-airport" };
    }
    return { pickedText: request.candidates[3].text, reasoning: "test-AI-train" };
  };

  const card = p.locator("td-day-card");
  await selectStationAddress(p, card, "运城", { disambiguator });

  const finalAir = await p.evaluate(() =>
    Array.from(
      document.querySelectorAll(
        '[data-testid="airport-combo"] .ant-select-selection__choice__content',
      ),
    ).map((t) => t.textContent),
  );
  const finalTrain = await p.evaluate(() =>
    Array.from(
      document.querySelectorAll(
        '[data-testid="train-combo"] .ant-select-selection__choice__content',
      ),
    ).map((t) => t.textContent),
  );
  assert.deepEqual(finalAir, ["运城关公机场"], "AI 应选中 airport 索引 1");
  assert.deepEqual(finalTrain, ["运城"], "exact 应选中 train「运城」");

  await b.close();
});

test("selectStationAddress 机场多候选时把太原交给 AI 并选择主流机场", async () => {
  const { selectStationAddress } = await loadFixture();
  const b = await chromium.launch({ headless: true });
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await ctx.newPage();
  await p.goto("file://" + path.join(__dirname, "../../fixtures/station-picker.html"), {
    waitUntil: "domcontentloaded",
  });
  await p.waitForTimeout(300);

  await p.evaluate(() => {
    window.STATION_DB.airport["太原"] = ["武宿国际机场", "太原尧城通用机场"];
    window.STATION_DB.train["太原"] = ["太原南站"];
  });

  let airportContext = null;
  const disambiguator = async (request) => {
    if (request.stationSubtype === "airport") {
      airportContext = { ...request, candidates: request.candidates.map((candidate) => candidate.text) };
      return { pickedText: "武宿国际机场", reasoning: "太原主流民航机场" };
    }
    return { pickedText: request.candidates[0].text, reasoning: "single train" };
  };

  const card = p.locator("td-day-card");
  await selectStationAddress(p, card, "太原", { disambiguator });

  const finalAir = await p.evaluate(() =>
    Array.from(
      document.querySelectorAll(
        '[data-testid="airport-combo"] .ant-select-selection__choice__content',
      ),
    ).map((t) => t.textContent),
  );
  assert.deepEqual(finalAir, ["武宿国际机场"], "太原机场多候选时应采用 AI 选出的主流机场");
  assert.deepEqual(airportContext, {
    kind: "station",
    stationSubtype: "airport",
    desired: "太原",
    candidates: ["武宿国际机场", "太原尧城通用机场"],
    product: {},
  });

  await b.close();
});

test("handleAirportTrainModal 已打开弹窗时也会调用 AI 选择机场候选", async () => {
  const { handleAirportTrainModal } = await loadFixture();
  const b = await chromium.launch({ headless: true });
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await ctx.newPage();
  await p.goto("file://" + path.join(__dirname, "../../fixtures/station-picker.html"), {
    waitUntil: "domcontentloaded",
  });
  await p.waitForTimeout(300);

  await p.evaluate(() => {
    window.STATION_DB.airport["太原"] = ["武宿国际机场", "太原尧城通用机场"];
    window.STATION_DB.train["太原"] = ["太原南站"];
    document.querySelector('[data-testid="station-dialog"]').style.display = "block";
  });

  const seenRequests = [];
  const disambiguator = async (request) => {
    seenRequests.push({
      kind: request.kind,
      stationSubtype: request.stationSubtype,
      desired: request.desired,
      candidates: request.candidates.map((candidate) => candidate.text),
    });
    if (request.stationSubtype === "airport") {
      return { pickedText: "武宿国际机场", reasoning: "太原主流民航机场" };
    }
    return { pickedText: request.candidates[0].text, reasoning: "single train" };
  };

  const handled = await handleAirportTrainModal(p, "太原", { disambiguator, product: {} });
  assert.equal(handled, true);

  const finalAir = await p.evaluate(() =>
    Array.from(
      document.querySelectorAll(
        '[data-testid="airport-combo"] .ant-select-selection__choice__content',
      ),
    ).map((t) => t.textContent),
  );
  assert.deepEqual(finalAir, ["武宿国际机场"], "已打开弹窗的兜底 handler 也必须采用 AI 选出的主流机场");
  assert.deepEqual(seenRequests[0], {
    kind: "station",
    stationSubtype: "airport",
    desired: "太原",
    candidates: ["武宿国际机场", "太原尧城通用机场"],
  });

  await b.close();
});

test("selectStationAddress 弹窗内部不被 closeBlockingDialogs 自关", async () => {
  // 锁定：函数运行期间弹窗一直保持 visible。
  // 这条契约：closeBlockingDialogs 会按 role=dialog 枚举并尝试关掉所有
  // 可见 dialog，selectStationAddress 必须不调它，否则接送站弹窗会被
  // 自己关掉。
  const { selectStationAddress } = await loadFixture();
  const b = await chromium.launch({ headless: true });
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await ctx.newPage();
  await p.goto("file://" + path.join(__dirname, "../../fixtures/station-picker.html"), {
    waitUntil: "domcontentloaded",
  });
  await p.waitForTimeout(300);

  // 装一个 DOM mutation observer：弹窗被关时记录
  await p.evaluate(() => {
    const dlg = document.querySelector('[data-testid="station-dialog"]');
    window.__dlgHideCount = 0;
    new MutationObserver(() => {
      if (dlg.style.display === "none") window.__dlgHideCount += 1;
    }).observe(dlg, { attributes: true, attributeFilter: ["style"] });
  });

  const card = p.locator("td-day-card");
  await selectStationAddress(p, card, "大同");

  // 弹窗应该被「确定」按钮关一次（隐式 close 路径 = 1 次 hide）
  const hideCount = await p.evaluate(() => window.__dlgHideCount);
  assert.ok(
    hideCount <= 1,
    `弹窗被关次数应 <= 1（只由「确定」关闭），实际 ${hideCount}`,
  );

  await b.close();
});
