import test from "node:test";
import assert from "node:assert/strict";
import { createAttentionNotificationDelivery } from "../../src/main/infrastructure/attention-notification-delivery.js";
import type { SystemNotificationResult } from "../../src/shared/contracts.js";

const attention = { key: "request-1", title: "需要补充", body: "打开应用继续" };

function harness() {
  let time = 0;
  let supported = true;
  let result: SystemNotificationResult = { shown: true, message: "已接收" };
  const sent: { title: string; body: string }[] = [];
  const warnings: string[] = [];
  const deliver = createAttentionNotificationDelivery({
    supported: () => supported,
    now: () => time,
    show: async (input) => { sent.push(input); return result; },
    onFailure: (message) => warnings.push(message),
  });
  return {
    deliver, sent, warnings,
    setSupported: (value: boolean) => { supported = value; },
    setTime: (value: number) => { time = value; },
    setResult: (value: SystemNotificationResult) => { result = value; },
  };
}

test("unsupported snapshots neither send nor warn, and do not mark delivery successful", async () => {
  const h = harness();
  h.setSupported(false);
  for (let i = 0; i < 100; i++) await h.deliver("product-1", attention);
  assert.equal(h.sent.length, 0);
  assert.deepEqual(h.warnings, []);
  h.setSupported(true);
  await h.deliver("product-1", attention);
  assert.equal(h.sent.length, 1);
});

test("successful reminders deduplicate while new requests and other products still notify", async () => {
  const h = harness();
  await h.deliver("product-1", attention);
  await h.deliver("product-1", attention);
  await h.deliver("product-1", { ...attention, key: "request-2" });
  await h.deliver("product-2", attention);
  assert.equal(h.sent.length, 3);
  assert.deepEqual(h.sent[0], { title: attention.title, body: attention.body });
  assert.deepEqual(h.warnings, []);
});

test("failed delivery cools down per product even when snapshot timestamps change, then retries", async () => {
  const h = harness();
  h.setResult({ shown: false, message: "macOS 拒绝通知" });
  await h.deliver("product-1", attention);
  for (let i = 0; i < 100; i++) {
    await h.deliver("product-1", { ...attention, key: `failed:${i}` });
  }
  h.setTime(59_999);
  await h.deliver("product-1", attention);
  assert.equal(h.sent.length, 1);
  assert.deepEqual(h.warnings, ["macOS 拒绝通知"]);
  h.setTime(60_000);
  h.setResult({ shown: true, message: "已接收" });
  await h.deliver("product-1", attention);
  await h.deliver("product-1", attention);
  assert.equal(h.sent.length, 2);
  assert.equal(h.warnings.length, 1);
});

test("concurrent snapshots share one in-flight attempt even past the retry interval", async () => {
  let finish!: (result: SystemNotificationResult) => void;
  let calls = 0;
  let time = 0;
  const deliver = createAttentionNotificationDelivery({
    supported: () => true,
    now: () => time,
    show: () => { calls++; return new Promise((resolve) => { finish = resolve; }); },
    onFailure: () => assert.fail("unexpected failure"),
  });
  const pending = deliver("product-1", attention);
  time = 120_000;
  await deliver("product-1", attention);
  assert.equal(calls, 1);
  finish({ shown: true, message: "已接收" });
  await pending;
  await deliver("product-1", attention);
  assert.equal(calls, 1);
});

test("unexpected send exceptions warn once and remain retryable", async () => {
  let time = 0;
  let calls = 0;
  const warnings: string[] = [];
  const deliver = createAttentionNotificationDelivery({
    supported: () => true,
    now: () => time,
    show: async () => { calls++; throw new Error("native notification error"); },
    onFailure: (message) => warnings.push(message),
  });
  await deliver("task-1", attention);
  await deliver("task-1", attention);
  assert.equal(calls, 1);
  time = 60_000;
  await deliver("task-1", attention);
  assert.equal(calls, 2);
  assert.deepEqual(warnings, ["native notification error", "native notification error"]);
});
