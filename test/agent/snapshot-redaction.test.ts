import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { VbkDatabase } from "../../src/main/infrastructure/database/database.js";
import { sanitizeAgentSnapshot } from "../../src/shared/agent-snapshot-sanitize.js";
import type { AgentSnapshot } from "../../src/shared/contracts.js";

function snapshot(overrides: Partial<AgentSnapshot> = {}): AgentSnapshot {
  return {
    localProductId: "p-1",
    updatedAt: "2026-09-12T00:00:00.000Z",
    run: {
      id: "run-1",
      status: "running",
      createdAt: "t",
      updatedAt: "t",
      error: "upstream apiKey=sk-live-secret failed",
    },
    events: [
      {
        id: "e1",
        runId: "run-1",
        type: "user",
        createdAt: "t",
        content: "把这个 key 配上 apiKey=sk-operator-secret",
      },
      {
        id: "e2",
        runId: "run-1",
        type: "tool_result",
        createdAt: "t",
        content: "ok",
        data: { apiKey: "sk-tool-secret", cookie: "sid=abc", poiName: "晋祠" },
      },
    ],
    ...overrides,
  };
}

test("Agent 快照落盘前脱敏 API key、cookie，并保留业务字段", () => {
  const safe = sanitizeAgentSnapshot(snapshot());
  const text = JSON.stringify(safe);
  assert.equal(text.includes("sk-live-secret"), false);
  assert.equal(text.includes("sk-operator-secret"), false);
  assert.equal(text.includes("sk-tool-secret"), false);
  assert.equal(text.includes("sid=abc"), false);
  assert.match(text, /\[已脱敏\]/);
  assert.equal(safe.events[1]?.data?.poiName, "晋祠");
  assert.equal(safe.run?.id, "run-1");
  assert.equal(safe.localProductId, "p-1");
});

test("saveAgentSnapshot 持久化的是脱敏后的对话，读回不含明文 key", () => {
  const dataPath = fs.mkdtempSync(path.join(os.tmpdir(), "vbk-snapshot-redact-"));
  const db = new VbkDatabase(dataPath);
  try {
    db.saveAgentSnapshot(snapshot());
    const loaded = db.getAgentSnapshot("p-1");
    assert.ok(loaded);
    const text = JSON.stringify(loaded);
    assert.equal(text.includes("sk-live-secret"), false);
    assert.equal(text.includes("sk-operator-secret"), false);
    assert.equal(text.includes("sk-tool-secret"), false);
    assert.equal(loaded.events[1]?.data?.poiName, "晋祠");
  } finally {
    fs.rmSync(dataPath, { recursive: true, force: true });
  }
});
