import assert from "node:assert/strict";
import test from "node:test";
import { validateIpcArguments } from "../../src/main/infrastructure/ipc-input.js";

test("产品写入与长流程通道拒绝空/超长/非法产品 ID", () => {
  for (const channel of ["ai:send", "planning:start", "automation:start", "products:updateProductJson"]) {
    assert.throws(() => validateIpcArguments(channel, ["../bad id", "{}"]), /invalid arguments/);
    assert.throws(() => validateIpcArguments(channel, ["x".repeat(161), "{}"]), /invalid arguments/);
  }
});

test("AI 消息、自动化阶段和产品 JSON 有明确运行时上限", () => {
  assert.doesNotThrow(() => validateIpcArguments("ai:send", ["p-1", "继续补齐"]));
  assert.throws(() => validateIpcArguments("ai:send", ["p-1", "x".repeat(6001)]), /field=content/);
  assert.throws(() => validateIpcArguments("automation:retryPhase", ["p-1", "unknown"]), /field=phase/);
  assert.throws(() => validateIpcArguments("products:updateProductJson", ["p-1", "x".repeat(2_000_001)]), /field=json/);
});

test("浏览器 bounds、导航 URL 与 providerId 拒绝错误类型", () => {
  assert.doesNotThrow(() => validateIpcArguments("browser:setBounds", [{ x: 0, y: 0, width: 1200, height: 800 }]));
  assert.throws(() => validateIpcArguments("browser:setBounds", [{ x: 0, y: 0, width: -1, height: 800 }]), /field=bounds/);
  assert.throws(() => validateIpcArguments("browser:navigate", ["not-a-url"]), /field=url/);
  assert.throws(() => validateIpcArguments("contacts:listProviderContactCards", [0]), /field=providerId/);
});

test("产品创建 payload 必须严格符合公开契约", () => {
  assert.doesNotThrow(() => validateIpcArguments("products:create", [{ destination: "太原", days: 2, productForm: "privateTour" }]));
  assert.throws(() => validateIpcArguments("products:create", [{ destination: "太原", days: 1, productForm: "privateTour" }]), /field=input/);
  assert.throws(() => validateIpcArguments("products:create", [{ destination: "太原", days: 0, productForm: "privateTour" }]), /field=input/);
  assert.throws(() => validateIpcArguments("products:create", [{ destination: "太原", days: 2, productForm: "privateTour", injected: true }]), /field=input/);
});
