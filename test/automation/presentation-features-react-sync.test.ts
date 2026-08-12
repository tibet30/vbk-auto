// @ts-nocheck
/** 「产品特色」React fiber 同步（features.react-sync.ts）的聚焦单元测试：
 *   - 真实结构下挂 mock React fiber，模拟「编辑器组件 onChange(html) → 祖先
 *     props.state.editproductDesc 更新」链路，验证 synced=true / field=editproductDesc；
 *   - 边界：onChange 抛错、state 不含目标文本、无 React fiber、#briefeditor 缺失；
 *   - 纯 helper（readFiberKeys / pickFiberKey）在浏览器侧挂非 enumerable key 后
 *     必须被识别；React 16 旧版 __reactInternalInstance$ 命名约定也必须兼容；
 *   - 「真实生产形态」路径：non-enumerable fiber key 必须被 syncReactOnChange 找到。
 *
 * 端到端 fillProductFeatures 路径（label + UEditor iframe + mock fiber）拆到
 * ./presentation-features-react-sync-e2e.test.ts，本文件聚焦 syncReactOnChange 单测。
 *
 * 顶部带 `// @ts-nocheck`，因为 page / locator 类型是动态传入。
 *
 * 注意：tsx（esbuild）会把对象字面量里的箭头函数改写成 `__name(fn, "key")` 来保留函数名；
 * 而 `__name` 在浏览器上下文里不存在，所以本文件的 mock helper 故意把所有「属性 = 箭头函数」
 * 改成「先占位为 null，再在对象外赋值」，避免触发 esbuild 的 name 保留。
 */
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { chromium, type Browser, type Page } from "playwright";
import {
  syncReactOnChange,
} from "../../src/main/automation/ctrip/presentation/features.react-sync.js";
import {
  readFiberKeys,
  pickFiberKey,
} from "../../src/main/automation/ctrip/presentation/features.react-helpers.js";

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

/**
 * 在 anchor 元素上挂一个 mock React fiber chain：
 *   - editorFiber.memoizedProps.onChange(html)：把 html 写到 ancestor.state.editproductDesc
 *   - ancestor.memoizedProps.state = { editproductDesc: "" }
 *   - ancestor.return = null（链终点）
 *
 * 可选 options：
 *   - throwOnChange=true：onChange 抛 Error（用于模拟异常路径）；
 *   - updateState=false：onChange 不更新 state（用于验证 readback 不命中路径）。
 *
 * 实现注意：所有「属性赋值箭头函数」都先占位 null 再在外赋值，避开 esbuild 的 __name 注入。
 */
async function installMockReactFiber(
  page: Page,
  options: { throwOnChange?: boolean; updateState?: boolean } = {},
): Promise<void> {
  await page.evaluate(
    ({ throwOnChange, updateState }: { throwOnChange: boolean; updateState: boolean }) => {
      const anchor = document.querySelector("#react-anchor");
      if (!anchor) throw new Error("no #react-anchor");
      const sharedState: { editproductDesc: string } = { editproductDesc: "" };
      const ancestor: any = { memoizedProps: null, pendingProps: null, return: null };
      const editor: any = { memoizedProps: null, pendingProps: null, return: ancestor };
      ancestor.memoizedProps = { state: sharedState };
      // 用「先占位 null 再赋值」避开 esbuild 的 __name(fn, "onChange") 注入
      const memoized: any = { onChange: null };
      memoized.onChange = (html: string) => {
        if (throwOnChange) {
          throw new Error("mock-onchange-threw");
        }
        if (updateState) {
          sharedState.editproductDesc = html;
        }
      };
      editor.memoizedProps = memoized;
      // React production 构建通过 Object.defineProperty 挂 fiber key，enumerable=false；
      // 只有 dev 构建才是 enumerable=true。生产代码必须走 Object.getOwnPropertyNames，
      // 所以这里也用 enumerable=false 来验证生产路径。
      Object.defineProperty(anchor, "__reactFiber$abcdef", {
        value: editor,
        enumerable: false,
        configurable: true,
        writable: true,
      });
    },
    {
      throwOnChange: Boolean(options.throwOnChange),
      updateState: options.updateState !== false,
    },
  );
}

test("React fiber：mock #briefeditor + 编辑器组件 onChange + 祖先 state.editproductDesc 必须 synced=true", async () => {
  const html = `<div id="briefeditor"><span id="react-anchor"></span></div>`;
  const page = await newPage(html);
  try {
    await installMockReactFiber(page);
    const result = await syncReactOnChange("目标 HTML 内容", page);
    assert.equal(result.synced, true, `mock React fiber 必须 synced=true；diagnostic=${result.diagnostic}`);
    assert.equal(result.reactDetected, true, "命中 fiber 时 reactDetected 必须为 true");
    assert.equal(result.field, "editproductDesc");
    assert.equal(result.diagnostic, "");
    // 确认 state 真的被更新
    const stateValue = await page.evaluate(() => {
      const anchor: any = document.querySelector("#react-anchor");
      const key = Object.getOwnPropertyNames(anchor).find((k) => k.startsWith("__reactFiber$"));
      if (!key) return null;
      let node = anchor[key];
      while (node) {
        const props = node.memoizedProps ?? node.pendingProps;
        if (props && typeof props === "object" && props.state) return props.state.editproductDesc;
        node = node.return;
      }
      return null;
    });
    assert.equal(stateValue, "目标 HTML 内容", "祖先 state.editproductDesc 必须被 onChange 写入目标");
  } finally {
    await page.close();
  }
});

test("React fiber：onChange 抛错时必须 synced=false + 明确诊断（不抛错到调用方）", async () => {
  const html = `<div id="briefeditor"><span id="react-anchor"></span></div>`;
  const page = await newPage(html);
  try {
    await installMockReactFiber(page, { throwOnChange: true });
    const result = await syncReactOnChange("目标", page);
    assert.equal(result.synced, false);
    assert.equal(result.reactDetected, true, "onChange 抛错时 reactDetected 必须为 true（已检测到 React）");
    assert.ok(/onchange-threw/.test(result.diagnostic), `诊断必须包含 onchange-threw；实际=${result.diagnostic}`);
    assert.ok(/mock-onchange-threw/.test(result.diagnostic), `诊断必须透传原始错误信息；实际=${result.diagnostic}`);
  } finally {
    await page.close();
  }
});

test("React fiber：onChange 调用成功但 state 没更新目标文本时必须 synced=false + 明确诊断", async () => {
  const html = `<div id="briefeditor"><span id="react-anchor"></span></div>`;
  const page = await newPage(html);
  try {
    await installMockReactFiber(page, { updateState: false });
    const result = await syncReactOnChange("目标文本", page);
    assert.equal(result.synced, false);
    assert.equal(result.reactDetected, true, "state 未更新但 fiber 已命中 → reactDetected=true（必须阻断）");
    assert.equal(result.field, "editproductDesc");
    assert.ok(/未含目标文本/.test(result.diagnostic), `诊断必须说明祖先 state 未命中；实际=${result.diagnostic}`);
  } finally {
    await page.close();
  }
});

test("React fiber：无 React fiber 时必须 synced=false + 空 diagnostic（向后兼容）", async () => {
  const html = `<div id="briefeditor"><span></span></div>`;
  const page = await newPage(html);
  try {
    const result = await syncReactOnChange("目标", page);
    assert.equal(result.synced, false);
    assert.equal(result.diagnostic, "", "无 React 时 diagnostic 必须为空（不污染 FeaturesResult）");
    assert.equal(result.reactDetected, false, "无 React 时 reactDetected 必须为 false（向后兼容，不阻断保存）");
  } finally {
    await page.close();
  }
});

test("React fiber：无 #briefeditor 时必须 synced=false + 空 diagnostic（向后兼容）", async () => {
  const html = `<div id="no-briefeditor-here"><span id="react-anchor"></span></div>`;
  const page = await newPage(html);
  try {
    await installMockReactFiber(page);
    const result = await syncReactOnChange("目标", page);
    assert.equal(result.synced, false);
    assert.equal(result.diagnostic, "", "无 #briefeditor 时 diagnostic 必须为空");
    assert.equal(result.reactDetected, false, "无 #briefeditor 时 reactDetected 必须为 false（向后兼容）");
  } finally {
    await page.close();
  }
});

/** 「纯 helper」 单元测试：在浏览器侧给 Object.defineProperty 挂上 React 内部键，
 * 验证 Object.getOwnPropertyNames 能看见它们（确认 __reactFiber$xxx 在生产构建中
 * 也是存在的，features.react-sync 的扫描逻辑不依赖 enumerable 属性）。 */
test("React helpers：readFiberKeys 必须识别非 enumerable 的 __reactFiber$ 前缀键", async () => {
  const page = await newPage(`<div id="briefeditor"></div>`);
  try {
    const allKeys = await page.evaluate(() => {
      const root = document.querySelector("#briefeditor") as any;
      Object.defineProperty(root, "__reactFiber$zzz", { value: "fiber", enumerable: false, configurable: true });
      Object.defineProperty(root, "__reactProps$abc", { value: "props", enumerable: false, configurable: true });
      Object.defineProperty(root, "data-test", { value: "x", enumerable: true, configurable: true });
      return Object.getOwnPropertyNames(root).sort();
    });
    assert.deepEqual(
      allKeys,
      ["__reactFiber$zzz", "__reactProps$abc", "data-test"],
      "__reactFiber$ / __reactProps$ / 普通键都必须在 Object.getOwnPropertyNames 中可见",
    );
    // 在 Node 侧验证 readFiberKeys / pickFiberKey 行为
    const filtered = readFiberKeys({ "__reactFiber$1": 1, "__reactProps$2": 2, other: 3 });
    assert.deepEqual(filtered, ["__reactFiber$1", "__reactProps$2"]);
    assert.equal(pickFiberKey(filtered), "__reactFiber$1");
    assert.equal(pickFiberKey([]), null);
    assert.equal(pickFiberKey(["__reactProps$x"]), null);
  } finally {
    await page.close();
  }
});

/** 在浏览器侧给 element 挂上 **非 enumerable** 的 React 内部键（生产构建的真实形态）：
 *  - __reactFiber$<rand> enumerable=false（production 构建的真实情况）；
 *  - Object.keys 会漏这些键，导致 features.react-sync 找不到 fiber。
 *  本测试只验证「非 enumerable key 必须在 Object.getOwnPropertyNames 中可见」，
 *  以及 syncReactOnChange 在 production 形态下能正确找到并调用 onChange。
 *  这是上一个 helper 单元测试覆盖不到的「真实生产形态 + 真实 page.evaluate 路径」用例。 */
test("React fiber 真实生产形态：非 enumerable fiber key 必须被 syncReactOnChange 找到", async () => {
  const html = `<div id="briefeditor"><span id="react-anchor"></span></div>`;
  const page = await newPage(html);
  try {
    // 1) 真实生产构建形态：React 通过 Object.defineProperty 挂 fiber key，
    //    enumerable=false（dev 模式才是 enumerable=true）。模拟这个真实形态，
    //    Object.keys 会看不到，必须用 Object.getOwnPropertyNames。
    await page.evaluate(() => {
      const anchor: any = document.querySelector("#react-anchor");
      if (!anchor) throw new Error("no #react-anchor");
      const sharedState: { editproductDesc: string } = { editproductDesc: "" };
      const ancestor: any = { memoizedProps: null, pendingProps: null, return: null };
      const editor: any = { memoizedProps: null, pendingProps: null, return: ancestor };
      ancestor.memoizedProps = { state: sharedState };
      const memoized: any = { onChange: null };
      memoized.onChange = (html: string) => {
        sharedState.editproductDesc = html;
      };
      editor.memoizedProps = memoized;
      // 关键：enumerable:false —— Object.keys 会漏，必须 Object.getOwnPropertyNames。
      Object.defineProperty(anchor, "__reactFiber$xyz", {
        value: editor,
        enumerable: false,
        configurable: true,
        writable: true,
      });
    });

    // 2) 先验证浏览器侧：Object.keys 看不到，Object.getOwnPropertyNames 看得到。
    const sanity = await page.evaluate(() => {
      const anchor: any = document.querySelector("#react-anchor");
      return {
        keysSeen: Object.keys(anchor),
        namesSeen: Object.getOwnPropertyNames(anchor),
      };
    });
    assert.deepEqual(
      sanity.keysSeen,
      [],
      "Object.keys 看不到非 enumerable 的 fiber key（与 React production 行为一致）",
    );
    assert.ok(
      sanity.namesSeen.includes("__reactFiber$xyz"),
      "Object.getOwnPropertyNames 必须能看到非 enumerable 的 fiber key",
    );

    // 3) 真实路径：syncReactOnChange 必须能命中 onChange。
    const result = await syncReactOnChange("生产形态目标 HTML", page);
    assert.equal(result.synced, true, `非 enumerable 路径必须 synced=true；diagnostic=${result.diagnostic}`);
    assert.equal(result.reactDetected, true, "命中 fiber 之后 reactDetected 必须为 true");
    assert.equal(result.field, "editproductDesc");
    assert.equal(result.diagnostic, "");
  } finally {
    await page.close();
  }
});

/** React 16 旧版 fiber key 是 `__reactInternalInstance$<rand>`，不是 `__reactFiber$`。
 *  生产构建同样 enumerable=false。本测试模拟 React 16 的命名约定，
 *  验证 features.react-sync 的扫描逻辑兼容旧版 key 前缀。 */
test("React fiber：兼容 React 16 旧版 __reactInternalInstance$ 命名约定", async () => {
  const html = `<div id="briefeditor"><span id="react-anchor"></span></div>`;
  const page = await newPage(html);
  try {
    await page.evaluate(() => {
      const anchor: any = document.querySelector("#react-anchor");
      if (!anchor) throw new Error("no #react-anchor");
      const sharedState: { editproductDesc: string } = { editproductDesc: "" };
      const ancestor: any = { memoizedProps: null, pendingProps: null, return: null };
      const editor: any = { memoizedProps: null, pendingProps: null, return: ancestor };
      ancestor.memoizedProps = { state: sharedState };
      const memoized: any = { onChange: null };
      memoized.onChange = (html: string) => {
        sharedState.editproductDesc = html;
      };
      editor.memoizedProps = memoized;
      // React 16 旧版 fiber key：__reactInternalInstance$<rand>，同样 enumerable=false
      Object.defineProperty(anchor, "__reactInternalInstance$abc", {
        value: editor,
        enumerable: false,
        configurable: true,
        writable: true,
      });
    });

    const result = await syncReactOnChange("React 16 旧版目标", page);
    assert.equal(
      result.synced,
      true,
      `React 16 旧版 key 路径必须 synced=true；diagnostic=${result.diagnostic}`,
    );
    assert.equal(result.reactDetected, true);
  } finally {
    await page.close();
  }
});

/** 关键回归：React 已检测到（DOM 上有 fiber）但 onChange 调用后祖先 state
 *  没更新目标文本时，reactDetected=true / synced=false —— 调用方必须阻断保存。
 *  这条与「无 React 旧页兼容」路径（reactDetected=false）的语义截然不同。 */
test("React fiber：state 不更新时 reactDetected=true，调用方必须能据此阻断保存", async () => {
  const html = `<div id="briefeditor"><span id="react-anchor"></span></div>`;
  const page = await newPage(html);
  try {
    await installMockReactFiber(page, { updateState: false });
    const result = await syncReactOnChange("目标", page);
    assert.equal(result.synced, false);
    assert.equal(
      result.reactDetected,
      true,
      "DOM 上有 fiber 且 onChange 已调用过 → reactDetected 必须为 true，调用方必须阻断",
    );
    assert.ok(result.diagnostic.length > 0, "真实失败必须带可操作诊断");
  } finally {
    await page.close();
  }
});

/** React 16 旧版 React 同样适用：DOM 上有 __reactInternalInstance$ 但 state 不更新时
 *  reactDetected=true / synced=false。 */
test("React fiber：React 16 旧版 fiber 存在但 state 不更新时 reactDetected=true", async () => {
  const html = `<div id="briefeditor"><span id="react-anchor"></span></div>`;
  const page = await newPage(html);
  try {
    await page.evaluate(() => {
      const anchor: any = document.querySelector("#react-anchor");
      const sharedState: { editproductDesc: string } = { editproductDesc: "" };
      const ancestor: any = { memoizedProps: null, pendingProps: null, return: null };
      const editor: any = { memoizedProps: null, pendingProps: null, return: ancestor };
      ancestor.memoizedProps = { state: sharedState };
      const memoized: any = { onChange: null };
      // 故意不写 state
      memoized.onChange = (_html: string) => { /* noop */ };
      editor.memoizedProps = memoized;
      Object.defineProperty(anchor, "__reactInternalInstance$abc", {
        value: editor,
        enumerable: false,
        configurable: true,
        writable: true,
      });
    });
    const result = await syncReactOnChange("目标", page);
    assert.equal(result.synced, false);
    assert.equal(
      result.reactDetected,
      true,
      "React 16 旧版 fiber 已检测但 state 未更新 → reactDetected 必须为 true",
    );
  } finally {
    await page.close();
  }
});