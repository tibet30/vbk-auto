// @ts-nocheck
/** 「产品特色」/「产品特点」富文本写入 helper（features.ts）的真实 Playwright 行为测试。
 * 覆盖（page.setContent 注入真实 DOM fixture）：1-5) 旧版 label 锚点 / iframe body / 缺失诊断 / #pm_features fallback / main.ts 抛错契约；6-11) 新版「产品特色」label + #briefeditor + UEditor iframe #ueditor_0 真实结构、fallback 及 hidden 校验。page 是动态传入。 */
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

test("产品特点：无关 contenteditable 不能被写入；只写 label 锚定的 textarea", async () => {
  const page = await newPage(buildLabelAdjacentTextareaHtml());
  try {
    const result = await fillProductFeatures(
      page,
      "本地深度讲解 + 1v1 行程定制 + 24h 用车",
    );

    assert.equal(result.filled, true, "fillProductFeatures 必须返回 filled=true");
    assert.equal(result.scopeSource, "label", "必须由 label 锚点找到作用域");
    assert.equal(result.editorType, "textarea", "目标编辑器类型必须是 textarea");

    const decoyText = await page.locator("#decoy-contenteditable").innerText();
    assert.equal(decoyText.trim(), "", "页面外的无关 contenteditable 必须不被写入");

    const featuresValue = await page.locator("#pm_features_text").inputValue();
    assert.ok(
      featuresValue.includes("本地深度讲解"),
      `textarea 必须写入产品特点文本，实际=${JSON.stringify(featuresValue)}`,
    );
  } finally {
    await page.close();
  }
});

test("产品特点：label 相邻 textarea 写入并回读（scopeSource=label, editorType=textarea）", async () => {
  const page = await newPage(buildLabelAdjacentTextareaHtml());
  try {
    const value = "含早餐；1 名当地管家全程跟随；纯玩无购物";
    const result = await fillProductFeatures(page, value);

    assert.equal(result.filled, true);
    assert.equal(result.scopeSource, "label");
    assert.equal(result.editorType, "textarea");
    assert.equal(result.diagnostic, "", "成功路径 diagnostic 必须为空");

    const observed = await page.locator("#pm_features_text").inputValue();
    assert.equal(observed, value, "textarea 回读必须与写入值完全一致");
  } finally {
    await page.close();
  }
});

test("产品特点：iframe body（ueditor/wangEditor 形态）写入并回读（editorType=iframe-body）", async () => {
  // iframe 用 srcdoc 把 contenteditable body 放进同源子文档，确保 contentFrame() 可用。
  const srcdoc = `<!doctype html><html><body contenteditable="true" id="ueditor-body"></body></html>`;
  const html = `
    <div class="ant-form-item" id="features-form-item-iframe">
      <div class="ant-form-item-label">
        <label for="features-iframe-id" title="产品特点">${FEATURES_LABEL_TEXT}</label>
      </div>
      <div class="ant-form-item-control">
        <div class="ant-form-item-control-input">
          <div class="ant-form-item-control-input-content">
            <iframe id="features-iframe-id" srcdoc="${srcdoc.replace(/"/g, "&quot;")}"></iframe>
          </div>
        </div>
      </div>
    </div>
  `;
  const page = await newPage(html);
  try {
    // 等待 iframe 子文档 ready 并把 body 标记成可编辑
    await page.waitForFunction(() => {
      const iframe = document.querySelector("#features-iframe-id") as HTMLIFrameElement | null;
      return Boolean(iframe?.contentDocument?.body);
    });

    const value = "深度讲解 · 1v1 行程定制 · 24h 用车";
    const result = await fillProductFeatures(page, value);

    assert.equal(result.filled, true, "iframe body 必须成功写入");
    assert.equal(result.scopeSource, "label", "iframe body 也必须由 label 锚点找到作用域");
    assert.equal(result.editorType, "iframe-body", "编辑器类型必须是 iframe-body");

    // 回读：iframe 子文档 body.innerText 必须包含写入文本
    const bodyText = await readIframeBodyText(page, "#features-iframe-id");
    assert.ok(
      bodyText.replace(/\s+/g, "").includes(value.replace(/\s+/g, "")),
      `iframe body 回读必须包含写入文本；实际=${JSON.stringify(bodyText)}`,
    );
  } finally {
    await page.close();
  }
});

test("产品特点：缺失时报诊断（无 label、无 #pm_features）", async () => {
  // 故意只放一个不相关表单与一个无「产品特点」label 的 textarea，必须不写入无关输入框、不静默成功，并返回 filled=false + 诊断。
  const html = `
    <div class="ant-form-item" id="unrelated">
      <div class="ant-form-item-label">
        <label title="行程亮点">行程亮点</label>
      </div>
      <div class="ant-form-item-control">
        <div class="ant-form-item-control-input-content">
          <textarea id="unrelated-textarea" class="ant-input">已存在文本</textarea>
        </div>
      </div>
    </div>
    <!-- 故意没有任何 #pm_features 容器 -->
  `;
  const page = await newPage(html);
  try {
    const result = await fillProductFeatures(page, "产品特点文本");

    assert.equal(result.filled, false, "缺失场景必须返回 filled=false");
    assert.equal(result.editorType, undefined, "缺失场景不应附带具体编辑器类型");
    assert.equal(result.scopeSource, undefined, "缺失场景不应附带具体作用域来源");
    assert.ok(
      typeof result.diagnostic === "string" && result.diagnostic.length > 0,
      `缺失场景必须返回非空 diagnostic；实际=${JSON.stringify(result.diagnostic)}`,
    );
    // 必须包含「label 锚点」或「作用域」或「#pm_features」等诊断关键词，便于排查
    assert.ok(/label 锚定的 \.ant-form-item|#pm_features|作用域/.test(result.diagnostic), `diagnostic 必须包含 label 锚点 / 作用域 / fallback 关键词；实际=${result.diagnostic}`);
    // 验证无关 textarea 没有被改写
    const unrelated = await page.locator("#unrelated-textarea").inputValue();
    assert.equal(unrelated, "已存在文本", "缺失场景必须不动无关输入框");
  } finally {
    await page.close();
  }
});

test("产品特点：label 锚点失败时回退 #pm_features 容器（scopeSource=fallback）", async () => {
  // 没有「产品特点」label，但有 #pm_features 容器（VBK 改版兜底场景）
  const html = `
    <div id="pm_features">
      <div class="ant-form-item">
        <div class="ant-form-item-control">
          <div class="ant-form-item-control-input-content">
            <textarea id="pm_features_textarea" class="ant-input"></textarea>
          </div>
        </div>
      </div>
    </div>
  `;
  const page = await newPage(html);
  try {
    const value = "全程纯玩无购物 + 当地深度讲解";
    const result = await fillProductFeatures(page, value);

    assert.equal(result.filled, true, "fallback 必须能写入 #pm_features 内的编辑器");
    assert.equal(result.scopeSource, "fallback", "作用域来源必须是 fallback");
    assert.equal(result.editorType, "textarea");

    const observed = await page.locator("#pm_features_textarea").inputValue();
    assert.equal(observed, value);
  } finally {
    await page.close();
  }
});

test("产品特点：错误必须以「找不到产品特点富文本输入框」开头且含诊断（main.ts 接线契约）", async () => {
  // 通过源码断言 main.ts 抛错模板，确保 fillProductFeatures 返回的诊断被正确传到错误前缀里。
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const here = path.dirname(fileURLToPath(import.meta.url));
  const mainSrc = await fs.readFile(path.resolve(here, "../../src/main/automation/ctrip/presentation/main.ts"), "utf8");
  const startIdx = mainSrc.indexOf("export async function fillAndSavePresentation");
  assert.ok(startIdx >= 0, "找不到 fillAndSavePresentation 定义");
  const endIdx = mainSrc.indexOf("\nfunction dayScopeFor", startIdx);
  const body = mainSrc.slice(startIdx, endIdx > 0 ? endIdx : mainSrc.length);
  assert.match(body, /throw new Error\(\s*`找不到产品特点富文本输入框/, "fillAndSavePresentation 必须以「找不到产品特点富文本输入框」开头抛错");
  // 错误模板必须包含 diagnostic 字段（注意：模板里 diagnostic 后面跟着 || 兜底，所以不能用 \$\{featuresResult\.diagnostic\} 这种精确形式，得允许后面再接一段）
  assert.match(
    body,
    /\$\{featuresResult\.diagnostic[^}]*\}/,
    "错误模板必须包含 featuresResult.diagnostic 拼接，便于排查",
  );
  // 必须保留 !filledFeatures 的判断分支
  assert.match(
    body,
    /if\s*\(\s*!filledFeatures\s*\)/,
    "fillAndSavePresentation 必须保留 !filledFeatures 失败分支",
  );
});

/** 真实 DOM fixture 的「产品特色」label 文本 + #briefeditor 容器 + UEditor iframe #ueditor_0（与 Electron CDP 在 productImageText?productId=76906037 上观察到的 DOM 一致）。 */
function buildRealBriefEditorHtml(): string {
  const srcdoc = `<!doctype html><html><body contenteditable="true" id="ue-body"></body></html>`;
  return `
    <style>.ant-select-dropdown-hidden { display: none; }</style>
    <div id="briefeditor">
      <div class="ant-form-item">
        <div class="ant-form-item-label">
          <label for="brief_features" title="产品特色">* 产品特色</label>
        </div>
        <div class="ant-form-item-control">
          <div class="ant-form-item-control-input">
            <div class="ant-form-item-control-input-content">
              <iframe id="ueditor_0" srcdoc="${srcdoc.replace(/"/g, "&quot;")}"></iframe>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
}

test("产品特色：新真实结构（label「产品特色」+ #briefeditor + UEditor iframe #ueditor_0）写入并回读", async () => {
  const page = await newPage(buildRealBriefEditorHtml());
  try {
    // 等 iframe 子文档 ready
    await page.waitForFunction(() => {
      const iframe = document.querySelector("#ueditor_0") as HTMLIFrameElement | null;
      return Boolean(iframe?.contentDocument?.body);
    });

    const value = "深度讲解 · 1v1 行程定制 · 24h 用车 · 当地管家全程跟随";
    const result = await fillProductFeatures(page, value);

    assert.equal(result.filled, true, "新真实结构必须成功写入");
    assert.equal(result.scopeSource, "label", "必须由「产品特色」label 锚点找到 .ant-form-item");
    assert.equal(result.editorType, "iframe-body", "编辑器类型必须是 iframe-body（UEditor body）");
    assert.equal(result.diagnostic, "", "成功路径 diagnostic 必须为空");

    // 回读：iframe body.innerText 必须包含写入文本
    const bodyText = await readIframeBodyText(page, "#ueditor_0");
    assert.ok(bodyText.replace(/\s+/g, "").includes(value.replace(/\s+/g, "")), `iframe body 回读必须包含写入文本；实际=${JSON.stringify(bodyText)}`);
    // 容器 ID 必须是真实 DOM 上的 #briefeditor / #ueditor_0
    assert.equal(await page.locator("#briefeditor").count(), 1);
    assert.equal(await page.locator("#ueditor_0").count(), 1);
  } finally {
    await page.close();
  }
});

test("产品特色：label 锚点失败时回退 #briefeditor 容器（scopeSource=fallback, editorType=iframe-body）", async () => {
  // 没有「产品特色」/「产品特点」label，只有 #briefeditor 容器 + UEditor iframe
  const srcdoc = `<!doctype html><html><body contenteditable="true"></body></html>`;
  const html = `
    <div id="briefeditor">
      <iframe id="ueditor_0" srcdoc="${srcdoc.replace(/"/g, "&quot;")}"></iframe>
    </div>
  `;
  const page = await newPage(html);
  try {
    await page.waitForFunction(() => {
      const iframe = document.querySelector("#ueditor_0") as HTMLIFrameElement | null;
      return Boolean(iframe?.contentDocument?.body);
    });

    const value = "fallback 走的也是 #briefeditor + UEditor";
    const result = await fillProductFeatures(page, value);

    assert.equal(result.filled, true, "fallback 必须能写入 #briefeditor 内的编辑器");
    assert.equal(result.scopeSource, "fallback", "作用域来源必须是 fallback");
    assert.equal(result.editorType, "iframe-body");

    const bodyText = await readIframeBodyText(page, "#ueditor_0");
    assert.ok(
      bodyText.replace(/\s+/g, "").includes(value.replace(/\s+/g, "")),
      `iframe body 回读必须包含写入文本；实际=${JSON.stringify(bodyText)}`,
    );
  } finally {
    await page.close();
  }
});

/** 在父页面注册一个模拟 UEditor 实例：sync 把 body.innerHTML 同步到 hidden textarea。noSync=true 时 sync 不动 hidden（用于验证未同步场景）。 */
async function installMockUEditor(page: Page, hiddenId: string | null, noSync: boolean): Promise<void> {
  await page.waitForFunction(() => Boolean(document.querySelector("#ueditor_0")?.contentDocument?.body));
  await page.evaluate(({ hiddenId, noSync }) => {
    const body = (document.querySelector("#ueditor_0") as HTMLIFrameElement).contentDocument!.body;
    const hidden = hiddenId ? document.querySelector(`#${hiddenId}`) as HTMLTextAreaElement : null;
    const editor: any = {
      body, options: { textarea: "briefeditor" },
      setContent(html: string) { body.innerHTML = html; },
      getContent() { return body.innerHTML; },
      sync() { if (hidden) hidden.value = body.innerHTML; },
    };
    (window as any).UE = { instants: { ueditorInstant0: editor } };
  }, { hiddenId, noSync });
}

test("UEditor：精确 parent.UE 实例 setContent + sync 后必须验证 hidden textarea", async () => {
  const srcdoc = `<!doctype html><html><body contenteditable="true"></body></html>`;
  const html = `<div id="briefeditor"><div class="ant-form-item"><label>产品特色</label><iframe id="ueditor_0" srcdoc="${srcdoc.replace(/"/g, "&quot;")}"></iframe><textarea id="ueditor_textarea_briefeditor" name="briefeditor"></textarea></div></div>`;
  const page = await newPage(html);
  try {
    await installMockUEditor(page, "ueditor_textarea_briefeditor", false);
    const value = "UEditor 精确实例同步成功";
    const result = await fillProductFeatures(page, value);
    assert.equal(result.filled, true);
    assert.ok((await page.locator("#ueditor_textarea_briefeditor").inputValue()).includes(value));
  } finally { await page.close(); }
});

test("UEditor：body 有字但 hidden textarea 未同步不得判成功", async () => {
  const srcdoc = `<!doctype html><html><body contenteditable="true"></body></html>`;
  const html = `<div id="briefeditor"><div class="ant-form-item"><label>产品特色</label><iframe id="ueditor_0" srcdoc="${srcdoc.replace(/"/g, "&quot;")}"></iframe><textarea name="briefeditor" style="display:none"></textarea></div></div>`;
  const page = await newPage(html);
  try {
    await installMockUEditor(page, null, true);
    const result = await fillProductFeatures(page, "不得仅凭 body 判定成功");
    assert.equal(result.filled, false);
  } finally { await page.close(); }
});

test("产品特色：完全无候选（无 label、无 #briefeditor、无 #pm_features）时报诊断且不改无关输入框", async () => {
  // 既无产品特色/产品特点 label，也无任何 fallback 容器；只剩一个不相关输入框；无关 textarea 不能被写入。
  const html = `
    <div class="ant-form-item" id="unrelated">
      <div class="ant-form-item-label">
        <label title="行程亮点">行程亮点</label>
      </div>
      <div class="ant-form-item-control">
        <div class="ant-form-item-control-input-content">
          <textarea id="unrelated-textarea" class="ant-input">已存在文本</textarea>
        </div>
      </div>
    </div>
  `;
  const page = await newPage(html);
  try {
    const result = await fillProductFeatures(page, "产品特色文本");

    assert.equal(result.filled, false, "完全无候选必须返回 filled=false");
    assert.equal(result.editorType, undefined, "缺失场景不应附带具体编辑器类型");
    assert.equal(result.scopeSource, undefined, "缺失场景不应附带具体作用域来源");
    assert.ok(
      typeof result.diagnostic === "string" && result.diagnostic.length > 0,
      `缺失场景必须返回非空 diagnostic；实际=${JSON.stringify(result.diagnostic)}`,
    );
    // diagnostic 必须包含新 fallback 关键词（或 label 锚点 / 作用域）
    assert.ok(/label (#pm |#brief|#产品)|#briefeditor|#pm_features|产品特色|产品特点|作用域/.test(result.diagnostic), `diagnostic 必须包含 label / fallback 容器 / 关键词上下文；实际=${result.diagnostic}`);

    // 验证无关 textarea 没有被改写（禁止全页盲扫）
    const unrelated = await page.locator("#unrelated-textarea").inputValue();
    assert.equal(unrelated, "已存在文本", "完全无候选时必须不动无关输入框");
  } finally {
    await page.close();
  }
});
