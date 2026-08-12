import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { chromium, type Browser, type Page } from "playwright";
import { ensureVehicleResource } from "../../src/main/automation/ctrip/resources.js";

let browser: Browser;

before(async () => {
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  await browser?.close();
});

function product() {
  return {
    sales: { productForm: "privateTour" },
    operations: { vehicleResource: { resourceGroupId: 101, resourceGroupName: "5座经济" } },
  };
}

function wrapPage(page: Page): Page {
  return new Proxy(page, {
    get(target, prop, receiver) {
      if (prop === "goto") return async () => undefined;
      return typeof Reflect.get(target, prop, receiver) === "function"
        ? (Reflect.get(target, prop, receiver) as Function).bind(target)
        : Reflect.get(target, prop, receiver);
    },
  }) as unknown as Page;
}

async function newPage(entryMarkup: string, delayMs = 0): Promise<Page> {
  const page = await browser.newPage();
  await page.setContent(`
    <div>资源配置</div>
    <button id="edit" onclick="this.dataset.clicked='true'">编 辑</button>
    <button id="save">保存</button>
    <div id="entries"></div>
    <button>提 交</button><button>提交审核</button>
    <div role="dialog" aria-label="校验"><span>校验结束</span><span>校验通过</span><button>确 定</button></div>
    <script>
      setTimeout(() => { document.querySelector('#entries').innerHTML = ${JSON.stringify(entryMarkup)}; }, ${delayMs});
    </script>
  `);
  return page;
}

function successfulFlowMarkup() {
  return '<div role="row">度假可选项/用车 101 旧资源组</div>';
}

test("延迟出现的全 disabled 附加资源入口返回 skipped 且不点击", async () => {
  const page = await newPage('<span class="item disacitve" onclick="this.dataset.clicked=\'true\'">附加资源</span>', 200);
  try {
    const result = await ensureVehicleResource(wrapPage(page), product(), "p", { entryTimeoutMs: 1_000 });
    // 文案只描述观察到的现象（附加资源入口全部 disabled），不得揣测套餐是否已保存。
    // 实机节奏：套餐已保存也可能在某些行程段呈现 disabled，需要中性 skip。
    assert.equal(result.skipped, "当前行程段附加资源入口 disabled");
    assert.equal(await page.locator("span.item").getAttribute("data-clicked"), null, "全 disabled 入口不得点击");
  } finally {
    await page.close();
  }
});

test("附加资源入口永不出现时在短 timeout 失败", async () => {
  const page = await newPage("", 0);
  try {
    await assert.rejects(
      () => ensureVehicleResource(wrapPage(page), product(), "p", { entryTimeoutMs: 80 }),
      (error: Error) => /资源入口未加载/.test(error.message),
    );
  } finally {
    await page.close();
  }
});

test("一个 disabled 和一个 enabled 时只点击 enabled 入口", async () => {
  const page = await newPage(
    `${successfulFlowMarkup()}<span class="item disacitve">附加资源</span><span class="item" id="enabled" onclick="this.dataset.clicked=\'true\'">附加资源</span>`,
  );
  try {
    const result = await ensureVehicleResource(wrapPage(page), product(), "p", { entryTimeoutMs: 500 });
    assert.equal(result.audited, true);
    assert.equal(await page.locator("#edit").getAttribute("data-clicked"), "true", "必须先点击编辑");
    assert.equal(await page.locator("#enabled").getAttribute("data-clicked"), "true");
  } finally {
    await page.close();
  }
});

test("编辑态的可添加附加资源即使保留 disacitve class 也会点击", async () => {
  const page = await newPage(
    `${successfulFlowMarkup()}<span class="item disacitve" id="editable-add" onclick="this.dataset.clicked='true'">可添加：附加资源</span>`,
  );
  try {
    const result = await ensureVehicleResource(wrapPage(page), product(), "p", { entryTimeoutMs: 500 });
    assert.equal(result.audited, true);
    assert.equal(await page.locator("#edit").getAttribute("data-clicked"), "true");
    assert.equal(await page.locator("#editable-add").getAttribute("data-clicked"), "true");
  } finally {
    await page.close();
  }
});

test("多个行程段有附加资源入口时选择首个可配置入口", async () => {
  const page = await newPage(
    `${successfulFlowMarkup()}<span class="item" id="first-enabled" onclick="this.dataset.clicked='true'">附加资源</span><span class="item" id="second-enabled">附加资源</span>`,
  );
  try {
    const result = await ensureVehicleResource(wrapPage(page), product(), "p", { entryTimeoutMs: 500 });
    assert.equal(result.audited, true);
    assert.equal(await page.locator("#first-enabled").getAttribute("data-clicked"), "true");
  } finally {
    await page.close();
  }
});
