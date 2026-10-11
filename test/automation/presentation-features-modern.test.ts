// @ts-nocheck
import { test, assert, fillProductFeatures, newPage, buildLabelAdjacentTextareaHtml, readIframeBodyText } from "./presentation-features.shared.js";

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
