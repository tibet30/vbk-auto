// @ts-nocheck
import { test, assert, fillProductFeatures, newPage, buildLabelAdjacentTextareaHtml, readIframeBodyText, FEATURES_LABEL_TEXT } from "./presentation-features.shared.js";

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

test("产品特色：安全 HTML 以富文本节点写入 iframe，不显示标签源码", async () => {
  const srcdoc = `<!doctype html><html><body contenteditable="true"></body></html>`;
  const page = await newPage(`
    <div class="ant-form-item">
      <label title="产品特色">产品特色</label>
      <iframe id="features-rich-editor" srcdoc="${srcdoc.replace(/"/g, "&quot;")}"></iframe>
    </div>
  `);
  try {
    await page.waitForFunction(() => Boolean(
      (document.querySelector("#features-rich-editor") as HTMLIFrameElement | null)?.contentDocument?.body,
    ));
    const value = "<p><strong>古建巡礼：</strong>游览晋祠古建。</p><p><strong>私享出行：</strong>专车衔接核心景点。</p>";
    const result = await fillProductFeatures(page, value);
    assert.equal(result.filled, true, result.diagnostic);
    const body = page.frameLocator("#features-rich-editor").locator("body");
    assert.equal(await body.locator("p").count(), 2);
    assert.equal(await body.locator("strong").count(), 2);
    assert.doesNotMatch(await body.innerText(), /<p>|<strong>/);
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
