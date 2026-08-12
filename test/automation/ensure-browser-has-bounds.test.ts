/**
 * ensureBrowserHasBounds 必须以 VbkBrowser 实例作为 this 调用 setBounds：
 *   - VbkBrowser.setBounds 内部 `this._bounds = bounds`，被解构后 this 会
 *     变成 undefined 并抛 "Cannot set properties of undefined (setting '_bounds')"；
 *   - view 已上报非零 bounds 时只 setVisible(true)，不覆盖；
 *   - fallback 尺寸保持「右 66% + 最小宽 640」的原约定（gate 3）。
 *
 * 测试技巧：helper 内部用 `createRequire(import.meta.url)` 解析 electron。
 * `createRequire` 与 `require` 共享 require.cache；只要在测试入口往
 * cache 里塞入替身，helper 解析到的就是我们的 BrowserWindow mock。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { ensureBrowserHasBounds } from "../../src/main/automation/automation.main/automation.main.class.helpers.js";

const helperRequire = createRequire(import.meta.url);
const electronPath = helperRequire.resolve("electron");

interface WindowSizeSource {
  getSize: () => [number, number];
}

let currentWindows: WindowSizeSource[] = [];

function installElectronMock() {
  const electronMock = {
    BrowserWindow: {
      getAllWindows: () => currentWindows,
    },
  };
  // createRequire 与全局 require 共享同一 require.cache；覆盖 helper
  // 内部会 resolve 到的条目，getAllWindows 即可走到我们的替身。
  const cached = helperRequire.cache[electronPath] as { exports: unknown } | undefined;
  if (cached && typeof cached === "object") {
    cached.exports = electronMock;
  } else {
    helperRequire.cache[electronPath] = {
      id: electronPath,
      filename: electronPath,
      loaded: true,
      exports: electronMock,
      children: [],
      paths: [],
    } as unknown as NodeJS.Module;
  }
}

interface BoundsCall {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface BrowserMockOptions {
  initialBounds: { width: number; height: number } | null;
  winSize: [number, number];
}

interface BrowserMock {
  setBounds(b: BoundsCall): void;
  setVisible(v: boolean): void;
  view: { getBounds: () => { width: number; height: number } | null };
  setBoundsCalls: BoundsCall[];
  setVisibleCalls: boolean[];
  setBoundsThis: unknown;
}

function makeBrowserMock({ initialBounds, winSize }: BrowserMockOptions): BrowserMock {
  const setBoundsCalls: BoundsCall[] = [];
  const setVisibleCalls: boolean[] = [];
  const mock: BrowserMock = {
    setBoundsCalls,
    setVisibleCalls,
    setBoundsThis: undefined,
    view: { getBounds: () => initialBounds },
    setBounds(b) {
      setBoundsCalls.push(b);
      mock.setBoundsThis = this;
    },
    setVisible(v) {
      setVisibleCalls.push(v);
    },
  };
  currentWindows = [{ getSize: () => winSize }];
  return mock;
}

test.before(() => {
  installElectronMock();
});

test("首次 0x0 bounds 以正确 this 调用 setBounds 并写入 66%/640 fallback", () => {
  const browser = makeBrowserMock({ initialBounds: null, winSize: [1280, 800] });

  // 关键断言：修复前这里会抛 "Cannot set properties of undefined (setting '_bounds')"；
  // 修复后必须不抛，且 setBounds 收到的 this 仍是 browser 实例本身。
  assert.doesNotThrow(() => ensureBrowserHasBounds(browser as unknown as Parameters<typeof ensureBrowserHasBounds>[0]));

  assert.equal(browser.setBoundsCalls.length, 1, "首次跨进程必须触发一次 setBounds");
  assert.strictEqual(browser.setBoundsThis, browser, "setBounds 必须以 browser 实例作为 this");
  assert.deepEqual(browser.setBoundsCalls[0], {
    x: 1280 - Math.max(640, Math.round(1280 * 0.66)),
    y: 0,
    width: Math.max(640, Math.round(1280 * 0.66)),
    height: 800,
  });
  assert.deepEqual(browser.setVisibleCalls, [true], "首次显示时也要把 view 设为可见");
});

test("view 已上报非零 bounds 时只 setVisible，不覆盖 setBounds", () => {
  const browser = makeBrowserMock({ initialBounds: { width: 900, height: 720 }, winSize: [1280, 800] });

  ensureBrowserHasBounds(browser as unknown as Parameters<typeof ensureBrowserHasBounds>[0]);

  assert.equal(browser.setBoundsCalls.length, 0, "已有非零 bounds 时不得覆盖 layout");
  assert.deepEqual(browser.setVisibleCalls, [true], "依旧要确保 view 可见");
});

test("fallback 宽度在窗口足够宽时按 66% 比例；窗口过窄时回退到最小宽 640", () => {
  // 窗口宽 → 66% > 640，按 0.66 计算
  const wide = makeBrowserMock({ initialBounds: null, winSize: [2000, 900] });
  ensureBrowserHasBounds(wide as unknown as Parameters<typeof ensureBrowserHasBounds>[0]);
  assert.equal(wide.setBoundsCalls.length, 1);
  const wideFallback = wide.setBoundsCalls[0].width;
  assert.equal(wideFallback, Math.max(640, Math.round(2000 * 0.66)));
  assert.equal(wide.setBoundsCalls[0].x, 2000 - wideFallback);

  // 窗口很窄 → 0.66 < 640，回退到 640
  const narrow = makeBrowserMock({ initialBounds: null, winSize: [800, 600] });
  ensureBrowserHasBounds(narrow as unknown as Parameters<typeof ensureBrowserHasBounds>[0]);
  assert.equal(narrow.setBoundsCalls.length, 1);
  assert.equal(narrow.setBoundsCalls[0].width, 640);
  assert.equal(narrow.setBoundsCalls[0].x, 800 - 640);
  assert.equal(narrow.setBoundsCalls[0].height, 600);
});

test("没有 BrowserWindow 主窗口或尺寸非法时安全退出，不动 setBounds", () => {
  // 没有任何窗口
  const noWindow = makeBrowserMock({ initialBounds: null, winSize: [1280, 800] });
  currentWindows = [];
  ensureBrowserHasBounds(noWindow as unknown as Parameters<typeof ensureBrowserHasBounds>[0]);
  assert.equal(noWindow.setBoundsCalls.length, 0);
  assert.equal(noWindow.setVisibleCalls.length, 0);

  // 窗口尺寸 0×0
  const zero = makeBrowserMock({ initialBounds: null, winSize: [0, 0] });
  currentWindows = [{ getSize: () => [0, 0] }];
  ensureBrowserHasBounds(zero as unknown as Parameters<typeof ensureBrowserHasBounds>[0]);
  assert.equal(zero.setBoundsCalls.length, 0);
  assert.equal(zero.setVisibleCalls.length, 0);
});
