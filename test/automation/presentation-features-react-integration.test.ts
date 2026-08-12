// @ts-nocheck
/** fillProductFeatures + UEditor iframe + mock React fiber 的独立 Playwright 集成测试。 */
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { chromium, type Browser, type Page } from "playwright";
import { fillProductFeatures } from "../../src/main/automation/ctrip/presentation/features.js";

let browser: Browser;

before(async () => {
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  await browser?.close();
});

async function newReactEditorPage(updateState: boolean): Promise<Page> {
  const srcdoc = `<!doctype html><html><body contenteditable="true"></body></html>`;
  const page = await browser.newPage();
  await page.setContent(`
    <div id="briefeditor">
      <div class="ant-form-item">
        <div class="ant-form-item-label">
          <label for="ueditor_0" title="产品特色">产品特色</label>
        </div>
        <div class="ant-form-item-control-input-content">
          <span id="react-anchor"></span>
          <iframe id="ueditor_0" srcdoc="${srcdoc.replace(/"/g, "&quot;")}"></iframe>
        </div>
      </div>
    </div>
  `);
  await page.waitForFunction(() => {
    const iframe = document.querySelector("#ueditor_0") as HTMLIFrameElement | null;
    return Boolean(iframe?.contentDocument?.body);
  });
  await page.evaluate((shouldUpdateState) => {
    const anchor: any = document.querySelector("#react-anchor");
    if (!anchor) throw new Error("no #react-anchor");

    const sharedState = { editproductDesc: "" };
    const ancestor: any = {
      memoizedProps: { state: sharedState },
      pendingProps: null,
      return: null,
    };
    const editor: any = {
      memoizedProps: { onChange: null },
      pendingProps: null,
      return: ancestor,
    };
    editor.memoizedProps.onChange = (html: string) => {
      if (shouldUpdateState) sharedState.editproductDesc = html;
    };
    Object.defineProperty(anchor, "__reactFiber$integration", {
      value: editor,
      enumerable: false,
      configurable: true,
      writable: true,
    });
  }, updateState);
  return page;
}

async function readAncestorDescription(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const anchor: any = document.querySelector("#react-anchor");
    const key = Object.getOwnPropertyNames(anchor ?? {}).find((name) =>
      name.startsWith("__reactFiber$"),
    );
    if (!key) return null;
    let fiber = anchor[key];
    while (fiber) {
      const props = fiber.memoizedProps ?? fiber.pendingProps;
      if (props?.state && "editproductDesc" in props.state) {
        return props.state.editproductDesc;
      }
      fiber = fiber.return;
    }
    return null;
  });
}

test("fillProductFeatures：非 enumerable React fiber 同步祖先 editproductDesc 后成功", async () => {
  const page = await newReactEditorPage(true);
  try {
    const value = "深度讲解 · 私家团 · 全程管家服务";
    const result = await fillProductFeatures(page, value);

    assert.equal(result.filled, true, `必须写入成功；diagnostic=${result.diagnostic}`);
    assert.equal(result.reactSynced, true, "React 受控状态必须同步成功");
    assert.equal(result.reactField, "editproductDesc");
    assert.equal(result.editorType, "iframe-body");
    assert.ok(
      (await readAncestorDescription(page))?.includes(value),
      "祖先 state.editproductDesc 回读必须包含目标文本",
    );
  } finally {
    await page.close();
  }
});

test("fillProductFeatures：检测到 fiber/onChange 但 state 不更新时阻断保存", async () => {
  const page = await newReactEditorPage(false);
  try {
    const value = "这段内容不得在 React 状态同步失败后保存";
    const result = await fillProductFeatures(page, value);

    assert.equal(result.filled, false, "React state 未更新时必须阻断保存");
    assert.equal(result.reactSynced, false, "检测到 React 但同步失败必须显式返回 false");
    assert.equal(result.reactField, "editproductDesc");
    assert.equal(result.editorType, "iframe-body");
    assert.equal(await readAncestorDescription(page), "", "祖先 state 必须保持未更新");
    assert.match(result.diagnostic, /未含目标文本|同步失败/, "失败结果必须带阻断诊断");
  } finally {
    await page.close();
  }
});
