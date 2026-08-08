/**
 * preflight 失败包装（buildPreflightFailureState）单元测试。
 *
 *  这层覆盖纯函数行为：
 *   - safeStorage 解密不可用 → 归类为 provider_not_configured；
 *   - PlannerError code 透传（provider_authentication / provider_not_configured）；
 *   - 其它任何 thrown 异常归为 unknown；
 *   - pending → failed 状态机迁移；
 *   - currentStage 保留（fresh start 时默认 skeleton）；
 *   - assistantReply 含「未完成」+「请检查 API Key」，
 *     永不出现「已完成 / 全部完成 / 成功 / sk- / 长 base64 / ciphertext」。
 *
 *  IPC 包装（main.ts try/catch + 持久化 / 写消息 / emit）走 preflight-ipc-contract.test.ts。
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPreflightFailureState,
  classifyPreflightError,
  redactSensitiveMessage,
  composePreflightFailureReply,
} from "../../src/main/planning/preflight-failure.js";
import type { PlanningGenerationState } from "../../src/shared/contracts-planning.js";

const PENDING_SKELETON: PlanningGenerationState = {
  projectId: "p",
  currentStage: "skeleton",
  completedStages: [],
  stages: [],
  status: "pending",
  resumeAt: "2024-01-01T00:00:00.000Z",
};

test("safeStorage 解密不可用 → state.status=failed，code=provider_not_configured，currentStage 保留", () => {
  // 真实 bug 现场的原始错误文本（含 ciphertext 字样 + 长 base64 模拟）。
  const rawCipher = "AAAAaaaaXXXXxxxxQQQQqqqqZZZZzzzz1111aaaa2222bbbb3333cccc4444dddd";
  const err = new Error(
    `Error while decrypting the ciphertext provided to safeStorage.decryptString. Decryption is not available. (${rawCipher})`,
  );
  const result = buildPreflightFailureState(PENDING_SKELETON, err);
  assert.equal(result.status, "failed");
  assert.equal(result.state.status, "failed", "持久化 state 必须是 failed");
  assert.equal(result.state.currentStage, "skeleton", "fresh start 时 currentStage 必须保留为 skeleton");
  assert.equal(classifyPreflightError(err), "provider_not_configured");
  const stageErr = result.state.stages[0]?.lastError;
  assert.ok(stageErr, "必须写入 stage-level lastError");
  assert.equal(stageErr.code, "provider_not_configured");
  assert.ok(!stageErr.message.includes(rawCipher), "lastError.message 必须 redact 长 base64");
  assert.ok(!/ciphertext/i.test(stageErr.message), "lastError.message 不应包含 ciphertext 字样");
});

test("assistant text 含「未完成」与「请检查 API Key」，不含「已完成 / 全部完成 / 成功」", () => {
  const err = new Error("Error while decrypting the ciphertext provided to safeStorage.decryptString. Decryption is not available.");
  const result = buildPreflightFailureState(PENDING_SKELETON, err);
  assert.ok(result.assistantReply.includes("未完成"), `reply 必须显式说「未完成」：${result.assistantReply}`);
  assert.ok(result.assistantReply.includes("请检查 API Key"), `reply 必须引导用户检查 API Key：${result.assistantReply}`);
  assert.ok(result.assistantReply.includes("重试规划"), `reply 必须引导用户点击重试规划：${result.assistantReply}`);
  assert.ok(
    !/已完成|全部完成|成功/.test(result.assistantReply),
    `reply 不得出现「已完成 / 全部完成 / 成功」等虚假声明：${result.assistantReply}`,
  );
  // secret 关键字 / 长 base64 / sk- 前缀一律不得泄露到 UI。
  assert.ok(!/ciphertext/i.test(result.assistantReply), `reply 不得出现 ciphertext 字样：${result.assistantReply}`);
  assert.ok(!/[A-Za-z0-9+/=]{40,}/.test(result.assistantReply), `reply 不得包含长 base64：${result.assistantReply}`);
  assert.ok(!/sk-[A-Za-z0-9]{20,}/.test(result.assistantReply), `reply 不得包含 sk- 前缀的 key：${result.assistantReply}`);
});

test("已有 currentStage=presentation 的持久化状态在失败后保留 currentStage", () => {
  const state: PlanningGenerationState = {
    ...PENDING_SKELETON,
    currentStage: "presentation",
    completedStages: ["skeleton", "itinerary"],
  };
  const err = new Error("decrypt failed");
  const result = buildPreflightFailureState(state, err);
  assert.equal(result.state.status, "failed");
  assert.equal(result.state.currentStage, "presentation", "resume 场景下 currentStage 必须保留");
  assert.deepEqual(result.state.completedStages, [], "preflight 失败时清空 completedStages（preflight 没有成功完成任何阶段）");
  assert.notEqual(result.state.resumeAt, state.resumeAt, "resumeAt 必须推进到 now（preflight 失败是一次新的续跑锚点）");
});

test("classifyPreflightError：known PlannerError code 透传", () => {
  assert.equal(classifyPreflightError({ code: "provider_not_configured", message: "x" }), "provider_not_configured");
  assert.equal(classifyPreflightError({ code: "provider_authentication", message: "x" }), "provider_authentication");
  assert.equal(classifyPreflightError({ code: "provider_connection", message: "x" }), "unknown", "transport 错误不应自动提升为 auth/configured");
});

test("classifyPreflightError：通过 message 关键字降级判断", () => {
  assert.equal(classifyPreflightError(new Error("decrypt failed")), "provider_not_configured");
  assert.equal(classifyPreflightError(new Error("authentication required")), "provider_authentication");
  assert.equal(classifyPreflightError(new Error("random boom")), "unknown");
});

test("redactSensitiveMessage：长 base64 替换为 [redacted]，短字符串保留", () => {
  const long = "AAAAaaaaXXXXxxxxQQQQqqqqZZZZzzzz1111aaaa2222bbbb3333cccc4444dddd";
  assert.equal(redactSensitiveMessage(`prefix ${long} suffix`), "prefix [redacted] suffix");
  assert.equal(redactSensitiveMessage("safeStorage.decryptString"), "safeStorage.decryptString");
});

test("composePreflightFailureReply 自身是 provider-neutral 且安全", () => {
  const reply = composePreflightFailureReply("provider_not_configured", "");
  assert.ok(reply.includes("未完成"));
  assert.ok(!/已完成|全部完成|成功/.test(reply));
  assert.ok(reply.includes("请检查 API Key"));
});

test("pending → failed 状态机迁移：resumeAt 必须推进", () => {
  const before = PENDING_SKELETON.resumeAt;
  const result = buildPreflightFailureState(PENDING_SKELETON, new Error("boom"));
  assert.equal(result.state.status, "failed");
  assert.notEqual(result.state.resumeAt, before, "resumeAt 必须从 pending 时间推进");
  assert.ok(new Date(result.state.resumeAt).getTime() > 0);
});

test("Adapter 构造抛错：状态仍归为 failed，message 是 redact 后的版本", () => {
  const err = new Error("TypeError: cannot construct adapter (sk-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG)");
  const result = buildPreflightFailureState(PENDING_SKELETON, err);
  assert.equal(result.state.status, "failed");
  assert.equal(classifyPreflightError(err), "unknown");
  assert.ok(!/sk-[A-Za-z0-9]{20,}/.test(result.state.stages[0]?.lastError?.message ?? ""));
  assert.ok(!/sk-[A-Za-z0-9]{20,}/.test(result.assistantReply));
});

test("runPlan 自身抛错（如 SQLITE_BUSY）：仍走 preflight 包装，status=failed", () => {
  const err = new Error("SQLITE_BUSY: database is locked");
  const result = buildPreflightFailureState(PENDING_SKELETON, err);
  assert.equal(result.state.status, "failed");
  assert.ok(result.assistantReply.includes("未完成"));
});

test("baseState 缺 currentStage 时默认到 skeleton", () => {
  const base = { ...PENDING_SKELETON, currentStage: undefined as unknown as PlanningGenerationState["currentStage"] };
  const result = buildPreflightFailureState(base, new Error("x"));
  assert.equal(result.state.currentStage, "skeleton");
});