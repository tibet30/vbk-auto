import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

test("产品图文：fillAndSavePresentation 必须通过 presentation-api 接口保存（main.ts 接线契约）", async () => {
  // 产品图文主流程已切到 SOA 接口保存：fillProductFeatures / fillRecommendationReasons
  // 不再被 fillAndSavePresentation 直接调用，原「找不到产品特点富文本输入框」
  // 抛错模板随之消除。本用例守住新契约：接口保存先于 saveThenAdvance、且不再回退
  // DOM 写入 / SaveMonitor。features.ts / save-monitor.ts 自身的单元测试在同文件
  // 其它用例与 presentation-save-monitor.test.ts 内覆盖。
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const here = path.dirname(fileURLToPath(import.meta.url));
  const mainSrc = await fs.readFile(path.resolve(here, "../../src/main/automation/ctrip/presentation/presentation/save.ts"), "utf8");
  const startIdx = mainSrc.indexOf("export async function fillAndSavePresentation");
  assert.ok(startIdx >= 0, "找不到 fillAndSavePresentation 定义");
  const endIdx = mainSrc.indexOf("\nfunction dayScopeFor", startIdx);
  const body = mainSrc.slice(startIdx, endIdx > 0 ? endIdx : mainSrc.length);
  // 接线：必须通过接口保存模块把产品特色 + 推荐理由落库
  assert.match(
    body,
    /savePresentationViaApi\(page,\s*presentation,\s*productId,\s*options\)/,
    "fillAndSavePresentation 必须通过接口保存模块写入产品特色与推荐理由",
  );
  // 顺序：先绑定封面，再保存图文；二者都必须使用显式 productId。
  const idxSaveApi = body.indexOf("savePresentationViaApi(");
  const idxCover = body.indexOf("bindCtripLibraryPresentationImages(");
  assert.ok(idxSaveApi >= 0 && idxCover >= 0, "必须同时存在图片绑定和图文保存调用");
  assert.ok(
    idxCover < idxSaveApi,
    `图片绑定必须先于图文保存；idxCover=${idxCover}, idxSaveApi=${idxSaveApi}`,
  );
  assert.doesNotMatch(body, /saveThenAdvance\(|clickSection\(|page\.reload|waitForURL/);
  // 反向红线：主流程不应再回退到 DOM 写入 / UI SaveMonitor
  assert.doesNotMatch(body, /fillProductFeatures\(page/, "产品图文主流程不应再通过 UEditor DOM 写入产品特色");
  assert.doesNotMatch(body, /fillRecommendationReasons\(page/, "产品图文主流程不应再通过 DOM 填写推荐理由");
  assert.doesNotMatch(body, /installSaveMonitor\(page\)/, "接口保存后主流程不应再安装 UI 保存 monitor");
  // 红线收敛：tabs.ts 不应被本任务改动（只收窄产品图文）
  const tabsSrc = await fs.readFile(path.resolve(here, "../../src/main/automation/ctrip/tabs.ts"), "utf8");
  assert.ok(
    !/installSaveMonitor|savedescriptioninfo|checkSensitiveWord/.test(tabsSrc),
    "tabs.ts 不应被产品图文接口保存任务改动",
  );
});

/** 产品图文已改为直接接口保存；monitor 仅保留单测覆盖旧 UI 保存守门行为。 */
test("产品图文主流程：仅使用显式产品 ID 的接口保存，不推进下一页", async () => {
  // 测试文件位于 <repo>/test/automation/，相对路径要往上 3 层到 repo root
  const here = resolve("test/automation/presentation-save-monitor.test.ts");
  const mainPath = resolve(here, "../../../src/main/automation/ctrip/presentation/presentation/save.ts");
  const src = await readFile(mainPath, "utf8");
  assert.ok(src.includes("savePresentationViaApi(page, presentation, productId, options)"));
  assert.match(src, /const cover = presentation\?\.cover;/, "图库封面绑定必须使用从 presentation 解析出的 cover");
  assert.match(src, /bindCtripLibraryPresentationImages\(page, cover, productId, options\)/,
    "图库封面绑定必须传入显式 productId");
  assert.doesNotMatch(src, /saveThenAdvance\(page|clickSection\(page|page\.reload|waitForURL/);
  assert.doesNotMatch(src, /installSaveMonitor\(page\)/, "接口保存后主流程不应再安装 UI 保存 monitor");
  // ensure tabs.ts 没有被改（守住「只收窄产品图文」红线）
  const tabsPath = resolve(here, "../../../src/main/automation/ctrip/tabs.ts");
  const tabsSrc = await readFile(tabsPath, "utf8");
  assert.ok(
    !/installSaveMonitor|savedescriptioninfo|checkSensitiveWord/.test(tabsSrc),
    "tabs.ts 不应被本任务改动（只收窄产品图文）",
  );
});

test("产品图文接口保存返回明确的 API 模式", async () => {
  const here = resolve("test/automation/presentation-save-monitor.test.ts");
  const mainPath = resolve(here, "../../../src/main/automation/ctrip/presentation/presentation/save.ts");
  const src = await readFile(mainPath, "utf8");
  assert.match(src, /mode: "presentation-api"/);
  assert.match(src, /return \{ advanced: true, mode: "presentation-api", productId, coverResult, savedWith \}/);
});
