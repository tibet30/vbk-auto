// @ts-nocheck
/** 「产品特色」/「产品特点」富文本写入 helper（features.ts）的真实 Playwright 行为测试。
 * 覆盖（page.setContent 注入真实 DOM fixture）：1-5) 旧版 label 锚点 / iframe body / 缺失诊断 / #pm_features fallback / features 单元覆盖；6-11) 新版「产品特色」label + #briefeditor + UEditor iframe #ueditor_0 真实结构、fallback 及 hidden 校验。页面层 main.ts 已切到 SOA 接口保存，移出 fillProductFeatures / fillRecommendationReasons，单独由 presentation-save-monitor.test.ts 与 presentation-api.test.ts / basic-info-fixes 守住接线。page 是动态传入。 */
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { chromium, type Browser, type Page } from "playwright";
import { fillProductFeatures } from "../../src/main/automation/ctrip/presentation/features.js";

const FEATURES_LABEL_TEXT = "产品特点";

let browser: Browser;

before(async () => {
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  await browser?.close();
});

async function newPage(html: string): Promise<Page> {
  const page = await browser.newPage();
  await page.setContent(html);
  return page;
}

/** label 相邻 textarea：标准 antd 结构，textarea 包裹在 .ant-form-item-control-input-content 里。 */
function buildLabelAdjacentTextareaHtml(): string {
  return `
    <style>.ant-select-dropdown-hidden { display: none; }</style>
    <!-- 页面其它区域的 contenteditable：必须不被写入 -->
    <div class="ant-form-item" id="decoy-recommendation">
      <label title="推荐理由">推荐理由</label>
      <div contenteditable="true" id="decoy-contenteditable" class="recommendation-text"
           data-testid="decoy-editable"
           style="min-height:60px;border:1px solid #ccc;padding:6px;"></div>
    </div>
    <div class="ant-form-item" id="features-form-item">
      <div class="ant-form-item-label">
        <label for="pm_features_text" title="产品特点">* ${FEATURES_LABEL_TEXT}</label>
      </div>
      <div class="ant-form-item-control">
        <div class="ant-form-item-control-input">
          <div class="ant-form-item-control-input-content">
            <textarea id="pm_features_text" class="ant-input" rows="6"
              placeholder="请输入产品特点"></textarea>
          </div>
        </div>
      </div>
    </div>
  `;
}

async function readIframeBodyText(page: Page, frameSelector: string): Promise<string> {
  return page.evaluate((sel) => {
    const iframe = document.querySelector(sel) as HTMLIFrameElement | null;
    if (!iframe) return "";
    const doc = iframe.contentDocument;
    return doc?.body?.innerText ?? "";
  }, frameSelector);
}

export { test, assert, fillProductFeatures, newPage, buildLabelAdjacentTextareaHtml, readIframeBodyText, FEATURES_LABEL_TEXT };
