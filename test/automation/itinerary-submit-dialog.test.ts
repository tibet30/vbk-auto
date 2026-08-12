import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { dismissKnownNoticeDialogs } from "../../src/main/automation/ctrip/dialogs.js";
import { saveThenAdvance } from "../../src/main/automation/ctrip/tabs.js";

test("线路变更提示与保存成功提示会确认，未知弹窗不会确认", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <div role="dialog" id="route"><h1>线路变更提示</h1><p>根据行程计算线路玩法</p><button>我知道了</button></div>
      <div role="dialog" id="unknown"><h1>风险提示</h1><button>我知道了</button></div>
      <script>
        document.querySelector('#route button').addEventListener('click', () => document.querySelector('#route').remove());
      </script>
    `);
    const routeResult = await dismissKnownNoticeDialogs(page);
    assert.equal(routeResult, true);
    assert.equal(await page.locator("#route").isVisible(), false);
    assert.equal(await page.locator("#unknown").isVisible(), true);

    await page.locator("#unknown").evaluate((node) => node.remove());
    await page.setContent(`<div role="dialog" id="saved"><h1>保存成功</h1><button>我知道了</button></div>
      <script>
        document.querySelector('#saved button').addEventListener('click', () => document.querySelector('#saved').remove());
      </script>`);
    const savedResult = await dismissKnownNoticeDialogs(page, { waitForSaveSuccess: true });
    assert.equal(savedResult, true);
    assert.equal(await page.locator("#saved").isVisible(), false);
  } finally {
    await browser.close();
  }
});

test("提交前会清理遗留线路提示，且 saveThenAdvance 仍要求目标 gate", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <div role="dialog" id="route"><h1>线路变更提示</h1><button>我知道了</button></div>
      <button id="save">存为草稿</button><button id="next">提交审核并下一步</button>
      <div role="tab" aria-selected="false" aria-disabled="true">套餐管理</div>
      <script>
        window.events = [];
        document.querySelector('#route button').addEventListener('click', () => { window.events.push('route'); document.querySelector('#route').remove(); });
        document.querySelector('#save').addEventListener('click', () => window.events.push('save'));
        document.querySelector('#next').addEventListener('click', () => window.events.push('next'));
      </script>
    `);
    await assert.rejects(
      () => saveThenAdvance(page, {
        phase: "行程",
        targetTabLabel: "套餐管理",
        saveButtonNames: ["存为草稿"],
        targetTabLabels: ["套餐管理"],
        nextButtonLabel: "提交审核并下一步",
        isTargetUrl: () => false,
      }),
      /未到达目标/,
    );
    assert.deepEqual(await page.evaluate(() => (window as any).events), ["route", "save", "next"]);
    assert.equal(await page.locator("#route").isVisible(), false);
  } finally {
    await browser.close();
  }
});
