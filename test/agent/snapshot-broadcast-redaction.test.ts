/**
 * IPC 出口脱敏契约单测。
 *
 * 历史漏洞（v1.1.19 前）：
 *   AgentCore.send/pause/resume 的返回值是 in-memory snapshot；落库路径
 *   saveAgentSnapshot 会走 sanitize，但返回到 IPC handler 的引用并未 sanitize。
 *   任何 IPC 出口若直接喂给 renderer / WebContents.send，会绕过 log-redaction。
 *
 * 修复路径（v1.1.19 release 之后的 redact-漏漏洞修复）：
 *   - src/main/main-events.ts:emitAgentSnapshot 入口 sanitizeAgentSnapshot；
 *   - src/main/ipc/agent-ipc.ts:emit 内部 sanitizeAgentSnapshot。
 *
 * 为什么本测试是"契约"而不是"端到端"：
 *   - main-events.ts 通过 transitive import 拉 electron，ESM dynamic import
 *     不支持 cjs require cache 拦截，无法在 node:test 里跑 createMainEventBroadcasters。
 *   - 但 sanitize + display 链路在 shared/ 与 agent-ipc.ts:emit 完全等价：
 *     agent-ipc.ts emit() = sanitizeAgentSnapshot + agentDisplaySnapshot；
 *     main-events emitAgentSnapshot 同理。
 *   - 因此"sanitize 干净 + display 仅做分页"既是 sanitize 的契约，也是 emit 端的契约。
 *
 * 谁违反契约就视为回归：
 *   - shared/agent-snapshot-sanitize 不能删任何字段；
 *   - shared/agent-display 不准私自再加 sanitize；
 *   - main-events/agent-ipc 任一处拿 snapshot 直接走 renderer 出口，都必须先 sanitize。
 */

import test from "node:test";
import assert from "node:assert/strict";
import type { AgentSnapshot } from "../../src/shared/contracts.js";
import { sanitizeAgentSnapshot } from "../../src/shared/agent-snapshot-sanitize.js";
import { agentDisplaySnapshot } from "../../src/shared/agent-display.js";

const SECRET_VALUES = Object.freeze([
  "sk-live-9876543210abcdef",
  "sk-operator-abcdef1234567890",
  "sk-tool-0123456789abcdef",
  "bearer-secret-9876543210",
  "csrf-secret-9999aaaa",
  "alice@example.com",
  "1234567",
]);

function secretSnapshot(): AgentSnapshot {
  return {
    localProductId: "product-leak",
    updatedAt: "2026-10-18T00:00:00.000Z",
    run: {
      id: "run-leak",
      status: "waiting_input",
      createdAt: "t",
      updatedAt: "t",
      error: "upstream apiKey=sk-live-9876543210abcdef failed",
    },
    events: [
      { id: "e-u", runId: "run-leak", type: "user", createdAt: "t",
        content: "把这个 key 配上 apiKey=sk-operator-abcdef1234567890" },
      { id: "e-t", runId: "run-leak", type: "tool_result", createdAt: "t",
        content: "ok",
        data: {
          apiKey: "sk-tool-0123456789abcdef",
          Authorization: "Bearer bearer-secret-9876543210",
          csrf: "csrf-secret-9999aaaa",
          vbkAccount: "alice@example.com",
          providerId: 1234567,
          poiName: "晋祠",
        },
      },
    ],
  };
}

/**
 * 与 main-events.ts emitAgentSnapshot、agent-ipc.ts emit() 等价的出口函数：
 *   sanitize + display。任何 IPC handler 偏离此序列视为回归。
 */
function emitToRenderer(snapshot: AgentSnapshot): { channel: string; payload: ReturnType<typeof agentDisplaySnapshot> } {
  const safe = sanitizeAgentSnapshot(snapshot);
  return { channel: "agent:updated", payload: agentDisplaySnapshot(safe) };
}

test("IPC 出口必须 sanitize：API key / Bearer / VBK 账号 / csrf 都被清洗", () => {
  const sent = emitToRenderer(secretSnapshot());
  const text = JSON.stringify(sent.payload);
  for (const secret of SECRET_VALUES) {
    assert.equal(text.includes(secret), false, `secret 没被 redact: ${secret}`);
  }
  assert.match(text, /\[已脱敏\]/);
  assert.match(text, /run-leak/);
  assert.match(text, /晋祠/);
});

test("IPC 出口对已 sanitize 的 snapshot 仍安全（idempotent）", () => {
  const sent = emitToRenderer(sanitizeAgentSnapshot(secretSnapshot()));
  const text = JSON.stringify(sent.payload);
  for (const secret of SECRET_VALUES) {
    assert.equal(text.includes(secret), false, secret);
  }
  assert.match(text, /\[已脱敏\]/);
});

test("IPC 出口不得保留明文 apiKey / Authorization / csrf / vbkAccount / providerId", () => {
  const sent = emitToRenderer(secretSnapshot());
  const payload = sent.payload as unknown as { events: Array<{ data?: Record<string, unknown> }> };
  for (const event of payload.events) {
    if (!event.data) continue;
    for (const key of ["apiKey", "Authorization", "csrf", "vbkAccount", "providerId"]) {
      const value = event.data[key];
      if (typeof value === "string") {
        assert.notEqual(value, "sk-tool-0123456789abcdef", `${key} 还是明文`);
        assert.notEqual(value, "Bearer bearer-secret-9876543210", `${key} 还是明文`);
        assert.notEqual(value, "csrf-secret-9999aaaa", `${key} 还是明文`);
        assert.notEqual(value, "alice@example.com", `${key} 还是明文`);
      }
    }
  }
});

test("agentDisplaySnapshot 不做 sanitize（职责单一：分页 + 计数）", () => {
  // 反向契约：禁止 agent-display.ts 私自再加 sanitize；任何 IPC 出口
  // 都必须自行 wrap sanitizeAgentSnapshot。这条测试禁止 display 层偷偷干
  // 两遍 redact（容易引入 bug + 多余的 snapshot 深拷贝）。
  const raw = secretSnapshot();
  const display = agentDisplaySnapshot(raw);
  const rawText = JSON.stringify(raw);
  assert.ok(rawText.includes("sk-live-9876543210abcdef"), "raw 必含 secret，证明没被侵入");
  assert.equal(display.eventCount, raw.events.length);
  assert.deepEqual(display.events, raw.events);
  const data = display.events[1].data as Record<string, unknown>;
  assert.equal(data.apiKey, "sk-tool-0123456789abcdef");
});
