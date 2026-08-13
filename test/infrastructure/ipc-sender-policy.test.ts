import assert from "node:assert/strict";
import test from "node:test";
import { isTrustedRendererSender } from "../../src/main/infrastructure/ipc-sender-policy.js";

const trusted = (url: string, overrides: Partial<Parameters<typeof isTrustedRendererSender>[0]> = {}) =>
  isTrustedRendererSender({
    url,
    isOwner: true,
    isMainFrame: true,
    isDev: true,
    ...overrides,
  });

test("开发版只接受 create-window 配置的固定 Vite loopback origin", () => {
  assert.equal(trusted("http://127.0.0.1:5173/products?tab=all"), true);

  assert.equal(trusted("http://localhost:5173/"), false);
  assert.equal(trusted("about:blank"), false);
  assert.equal(trusted("https://127.0.0.1:5173/"), false);
  assert.equal(trusted("http://127.0.0.1:5174/"), false);
  assert.equal(trusted("http://127.0.0.1.evil.example:5173/"), false);
  assert.equal(trusted("file:///Applications/VBK.app/Contents/Resources/app.asar/dist/index.html"), false);
});

test("打包版按 file: protocol 判断，不依赖值为 null 的 URL.origin", () => {
  const packaged = { isDev: false };
  assert.equal(trusted("file:///Applications/VBK.app/Contents/Resources/app.asar/dist/index.html", packaged), true);
  assert.equal(new URL("file:///tmp/index.html").origin, "null");
  assert.equal(trusted("http://127.0.0.1:5173/", packaged), false);
  assert.equal(trusted("https://example.com/", packaged), false);
  assert.equal(trusted("about:blank", packaged), false);
});

test("无 owner、子 frame 和非法 URL 在两种模式下都拒绝", () => {
  assert.equal(trusted("http://127.0.0.1:5173/", { isOwner: false }), false);
  assert.equal(trusted("http://127.0.0.1:5173/", { isMainFrame: false }), false);
  assert.equal(trusted("file:///tmp/index.html", { isDev: false, isMainFrame: false }), false);
  assert.equal(trusted("not a url"), false);
  assert.equal(trusted("", { isDev: false }), false);
});
