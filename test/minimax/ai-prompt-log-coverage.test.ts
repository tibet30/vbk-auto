/**
 * AI prompt 日志覆盖测试：
 *   - MiniMaxService.testConnection / reply(每次重试) / diagnoseAutomationFailure / disambiguateOption
 *     在每次实际 AI 调用前都会打 `[AI prompt]` 日志，里面含完整 messages；
 *   - OpenAICompatiblePlannerAdapter.generateStage / resolvePoiName 同上；
 *   - 日志不会泄漏 fake apiKey（即便把 apiKey 拼到 message 里也会被 redact）；
 *   - 入口标识 entry 与 model 字段正确出现。
 *
 * 测试只使用 console spy + 内置 http.createServer + fake apiKey，不依赖任何外部 mock 框架。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { MiniMaxService } from "../../src/main/minimax/minimax.js";
import { OpenAICompatiblePlannerAdapter } from "../../src/main/planning/adapters/openai-compatible-adapter.js";
import type { AdvisorRequest, DisambiguateRequest } from "../../src/shared/contracts.js";
import type { PlannerRequest, PoiNameResolutionRequest } from "../../src/shared/contracts-planning.js";

type Spy = { logs: { level: string; args: unknown[] }[]; restore: () => void };

function installConsoleSpy(): Spy {
  const logs: { level: string; args: unknown[] }[] = [];
  const original = { info: console.info, warn: console.warn, error: console.error, log: console.log, debug: console.debug };
  const wrap = (level: keyof typeof original) => (...args: unknown[]) => { logs.push({ level, args }); };
  (console as unknown as Record<string, (...a: unknown[]) => void>).info = wrap("info");
  (console as unknown as Record<string, (...a: unknown[]) => void>).warn = wrap("warn");
  (console as unknown as Record<string, (...a: unknown[]) => void>).error = wrap("error");
  (console as unknown as Record<string, (...a: unknown[]) => void>).log = wrap("log");
  (console as unknown as Record<string, (...a: unknown[]) => void>).debug = wrap("debug");
  return {
    logs,
    restore() {
      (console as unknown as Record<string, (...a: unknown[]) => void>).info = original.info;
      (console as unknown as Record<string, (...a: unknown[]) => void>).warn = original.warn;
      (console as unknown as Record<string, (...a: unknown[]) => void>).error = original.error;
      (console as unknown as Record<string, (...a: unknown[]) => void>).log = original.log;
      (console as unknown as Record<string, (...a: unknown[]) => void>).debug = original.debug;
    },
  };
}

function findPromptLog(spy: Spy, entry: string): { level: string; payload: Record<string, unknown> } | undefined {
  for (const item of spy.logs) {
    // logInfo("[AI prompt]", json) 会变成 console.info("YYYY-MM-DD HH:MM:SS.SSS [AI prompt]", json)
    // —— args[0] 是拼好的 ts+prefix 串，args[1] 是 json。
    if (item.args.length < 2) continue;
    const head = item.args[0];
    const body = item.args[1];
    if (typeof head !== "string") continue;
    const tsMatch = head.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}) \[AI prompt\](?:\s|$)/);
    if (!tsMatch) continue;
    if (typeof body !== "string") continue;
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(body) as Record<string, unknown>; } catch { continue; }
    if (parsed.entry === entry) return { level: item.level, payload: parsed };
  }
  return undefined;
}

function findAllPromptLogs(spy: Spy, entry: string): { level: string; payload: Record<string, unknown> }[] {
  const out: { level: string; payload: Record<string, unknown> }[] = [];
  for (const item of spy.logs) {
    if (item.args.length < 2) continue;
    const head = item.args[0];
    const body = item.args[1];
    if (typeof head !== "string") continue;
    const tsMatch = head.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}) \[AI prompt\](?:\s|$)/);
    if (!tsMatch) continue;
    if (typeof body !== "string") continue;
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(body) as Record<string, unknown>; } catch { continue; }
    if (parsed.entry === entry) out.push({ level: item.level, payload: parsed });
  }
  return out;
}

async function bootService(t: test.TestContext, respond: (res: ServerResponse) => void): Promise<MiniMaxService> {
  const server = createServer((_req, res) => respond(res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const addr = server.address();
  assert.ok(addr && typeof addr !== "string");
  return new MiniMaxService({ apiKey: "fake-key-for-test", baseUrl: `http://127.0.0.1:${addr.port}/v1`, model: "fake-model" });
}

async function bootAdapter(t: test.TestContext, respond: (res: ServerResponse) => void): Promise<OpenAICompatiblePlannerAdapter> {
  const server = createServer((_req, res) => respond(res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const addr = server.address();
  assert.ok(addr && typeof addr !== "string");
  return new OpenAICompatiblePlannerAdapter({
    apiKey: "fake-key-for-test",
    baseUrl: `http://127.0.0.1:${addr.port}/v1`,
    model: "fake-model",
    provider: "fake-provider",
  });
}

function okChatResponse(): string {
  return JSON.stringify({ choices: [{ message: { content: "pong" } }] });
}

function okToolCallResponse(name: string, args: unknown): string {
  return JSON.stringify({
    choices: [{ message: {
      content: null,
      tool_calls: [{ id: "call_x", type: "function", function: { name, arguments: JSON.stringify(args) } }],
    } }],
  });
}

test("MiniMax.testConnection 在每次 AI 调用前打 [AI prompt]，含 messages，不含 apiKey", async (t) => {
  const spy = installConsoleSpy();
  t.after(() => spy.restore());
  const service = await bootService(t, (res) => { res.setHeader("content-type", "application/json"); res.end(okChatResponse()); });
  await service.testConnection();
  const log = findPromptLog(spy, "MiniMax.testConnection");
  assert.ok(log, "必须出现 entry=MiniMax.testConnection 的 [AI prompt] 日志");
  assert.equal(log.level, "info");
  assert.equal(log.payload.model, "fake-model");
  assert.equal((log.payload.messages as unknown[]).length, 1);
  const joined = JSON.stringify(log.payload);
  assert.equal(joined.includes("fake-key-for-test"), false, "日志严禁包含 apiKey");
  assert.match(joined, /"role":"user"/);
});

test("MiniMax.reply 单次成功调用打 [AI prompt]，attempt=0", async (t) => {
  const spy = installConsoleSpy();
  t.after(() => spy.restore());
  const validReply = {
    reply: "已生成方案。",
    patch: [{ op: "add", path: "/basicInfo/subtitle", value: "太原精华一日" }],
    questions: [],
    researchTasks: [],
  };
  const service = await bootService(t, (res) => { res.setHeader("content-type", "application/json"); res.end(okToolCallResponse("submit_product_update", validReply)); });
  await service.reply({ message: "生成第一版", product: { basicInfo: { meetingCity: "太原" }, itinerary: [] }, history: [] });
  const logs = findAllPromptLogs(spy, "MiniMax.reply");
  assert.equal(logs.length, 1, "单次成功只打一次 prompt 日志");
  assert.equal(logs[0].payload.attempt, 0);
  const joined = JSON.stringify(logs[0].payload);
  assert.equal(joined.includes("fake-key-for-test"), false);
  assert.match(joined, /生成第一版/);
});

test("MiniMax.reply 多次重试：每次重试 attempt 递增，且每次都打 [AI prompt]", async (t) => {
  const spy = installConsoleSpy();
  t.after(() => spy.restore());
  // 第 1、2 次返回缺 patch（invalid），第 3 次返回有效 patch。
  let call = 0;
  const validReply = {
    reply: "已生成方案。",
    patch: [{ op: "add", path: "/basicInfo/subtitle", value: "太原精华一日" }],
    questions: [],
    researchTasks: [],
  };
  const service = await bootService(t, (res) => {
    call += 1;
    res.setHeader("content-type", "application/json");
    if (call >= 3) res.end(okToolCallResponse("submit_product_update", validReply));
    else res.end(okToolCallResponse("submit_product_update", { reply: "暂无可写", patch: [], questions: [], researchTasks: [] }));
  });
  await service.reply({ message: "继续补齐", product: { basicInfo: { meetingCity: "太原" }, itinerary: [] }, history: [] });
  const logs = findAllPromptLogs(spy, "MiniMax.reply");
  // planningRetryLimit=4，预期至少 attempts 0,1,2,3（>=3 次重试后才成功）。
  assert.ok(logs.length >= 3, `重试路径下应有多次 prompt 日志，实际 ${logs.length}`);
  const attempts = logs.map((l) => l.payload.attempt);
  assert.deepEqual(attempts.slice(0, 3), [0, 1, 2]);
  for (const l of logs) {
    const joined = JSON.stringify(l.payload);
    assert.equal(joined.includes("fake-key-for-test"), false);
  }
});

test("MiniMax.diagnoseAutomationFailure 打 [AI prompt]，含上下文且不含 apiKey", async (t) => {
  const spy = installConsoleSpy();
  t.after(() => spy.restore());
  const validDiagnosis = {
    summary: "基础信息未真正落库。",
    rootCause: "保存动作返回失败。",
    action: "retry_same_phase",
    expectedEvidence: "重试成功后基本信息显示已保存。",
  };
  const service = await bootService(t, (res) => { res.setHeader("content-type", "application/json"); res.end(okToolCallResponse("submit_failure_diagnosis", validDiagnosis)); });
  const input: AdvisorRequest = {
    phase: "basic", attempt: 1, error: "保存失败", productIdExists: true, basicInfoSaved: false,
    completedPhases: ["shell"], diagnosisHistory: [],
  };
  await service.diagnoseAutomationFailure(input);
  const log = findPromptLog(spy, "MiniMax.diagnoseAutomationFailure");
  assert.ok(log);
  const joined = JSON.stringify(log.payload);
  assert.equal(joined.includes("fake-key-for-test"), false);
  assert.match(joined, /基础信息未真正落库|retry_same_phase|submit_failure_diagnosis|phase/);
});

test("MiniMax.disambiguateOption 打 [AI prompt]，含 desired 与 candidates", async (t) => {
  const spy = installConsoleSpy();
  t.after(() => spy.restore());
  const disambig = { pickedText: "山西", reasoning: "与产品主要讲山西一致" };
  const service = await bootService(t, (res) => { res.setHeader("content-type", "application/json"); res.end(okToolCallResponse("submit_disambiguation", disambig)); });
  const input: DisambiguateRequest = {
    kind: "province", desired: "山西",
    candidates: [{ id: "1", text: "山西" }, { id: "2", text: "陕西" }],
    product: { basicInfo: { meetingCity: "太原" } },
  };
  await service.disambiguateOption(input);
  const log = findPromptLog(spy, "MiniMax.disambiguateOption");
  assert.ok(log);
  const joined = JSON.stringify(log.payload);
  assert.equal(joined.includes("fake-key-for-test"), false);
  assert.match(joined, /山西/);
});

test("Planner.generateStage 打 [AI prompt]，含 system + user messages", async (t) => {
  const spy = installConsoleSpy();
  t.after(() => spy.restore());
  const adapter = await bootAdapter(t, (res) => {
    res.setHeader("content-type", "application/json");
    res.end(okToolCallResponse("submit_basicInfo_module", { reply: "ok", modules: [{ module: "basicInfo", status: "accepted", value: { subtitle: "太原精华之旅", province: "山西", operationNotes: "待核查" } }] }));
  });
  const req: PlannerRequest = {
    stage: "basicInfo",
    context: {
      skeleton: { destination: "太原", days: 2, nights: 1, productForm: "privateTour", productType: "domesticShort", supplierProductCode: "NEW" },
      acceptedModules: [],
      existingResearchTasks: [],
      currentProduct: { basicInfo: {} },
    },
  };
  await adapter.generateStage(req);
  const log = findPromptLog(spy, "Planner.generateStage");
  assert.ok(log);
  assert.equal(log.payload.provider, "fake-provider");
  const joined = JSON.stringify(log.payload);
  assert.equal(joined.includes("fake-key-for-test"), false);
  assert.match(joined, /destination\s*=\s*太原/);
});

test("Planner.resolvePoiName 打 [AI prompt]，含 POI 名称与候选", async (t) => {
  const spy = installConsoleSpy();
  t.after(() => spy.restore());
  const adapter = await bootAdapter(t, (res) => {
    res.setHeader("content-type", "application/json");
    res.end(okToolCallResponse("submit_vbk_poi_name", { poiName: "西安钟楼" }));
  });
  const req: PoiNameResolutionRequest = { destination: "西安", originalName: "钟楼", attempt: 1, previousCandidates: [] };
  await adapter.resolvePoiName(req);
  const log = findPromptLog(spy, "Planner.resolvePoiName");
  assert.ok(log);
  const joined = JSON.stringify(log.payload);
  assert.equal(joined.includes("fake-key-for-test"), false);
  assert.match(joined, /西安/);
});

test("[AI prompt] 日志会把 message content 里的字面凭据模式 redact 成 [REDACTED:*]", async (t) => {
  const spy = installConsoleSpy();
  t.after(() => spy.restore());
  const leakMessage = "如果 API Key=sk-LIVEabcdef0123456789 泄漏会怎样？以及 Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature、Cookie: sid=abcd1234efgh、token=zzzzzzzz.yyyyyyyy.xxxxxxxx 都会。";
  const validReply = {
    reply: "已处理。",
    patch: [{ op: "add", path: "/basicInfo/subtitle", value: "太原截断恢复" }],
    questions: [],
    researchTasks: [],
  };
  const service = await bootService(t, (res) => {
    res.setHeader("content-type", "application/json");
    res.end(okToolCallResponse("submit_product_update", validReply));
  });
  // 把含凭据字面量的字符串作为用户消息注入。
  await service.reply({ message: leakMessage, product: { basicInfo: { meetingCity: "太原" }, itinerary: [] }, history: [] });
  const log = findPromptLog(spy, "MiniMax.reply");
  assert.ok(log);
  const joined = JSON.stringify(log.payload);
  assert.equal(joined.includes("sk-LIVEabcdef0123456789"), false, "apiKey 字面量必须被 redact");
  assert.equal(joined.includes("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"), false, "Bearer token 字面量必须被 redact");
  assert.equal(joined.includes("sid=abcd1234efgh"), false, "Cookie 字面量必须被 redact");
  assert.equal(joined.includes("zzzzzzzz.yyyyyyyy.xxxxxxxx"), false, "JWT token 字面量必须被 redact");
  assert.match(joined, /\[REDACTED:apikey\]|\[REDACTED:authorization\]|\[REDACTED:cookie\]|\[REDACTED:token\]/);
});

test("[AI prompt] 日志严禁出现 fake-key-for-test 凭据字面量（多种入口）", async (t) => {
  const spy = installConsoleSpy();
  t.after(() => spy.restore());
  const validDiagnosis = {
    summary: "重试。", rootCause: "暂存。", action: "retry_same_phase", expectedEvidence: "已存。",
  };
  // 使用 2 个不同 server 避免第一个请求占满响应。
  const service = await bootService(t, (res) => { res.setHeader("content-type", "application/json"); res.end(okToolCallResponse("submit_failure_diagnosis", validDiagnosis)); });
  await service.diagnoseAutomationFailure({
    phase: "basic", attempt: 1, error: "保存失败", productIdExists: true, basicInfoSaved: false, completedPhases: ["shell"], diagnosisHistory: [],
  });
  // 为 disambiguateOption 起一个独立 server。
  const disambigService = await bootService(t, (res) => { res.setHeader("content-type", "application/json"); res.end(okToolCallResponse("submit_disambiguation", { pickedText: "山西", reasoning: "与产品主要讲山西一致" })); });
  await disambigService.disambiguateOption({
    kind: "province", desired: "山西",
    candidates: [{ id: "1", text: "山西" }, { id: "2", text: "陕西" }],
    product: { basicInfo: { meetingCity: "太原" } },
  });
  const joined = spy.logs.map((l) => l.args.map((a) => typeof a === "string" ? a : JSON.stringify(a)).join(" ")).join("\n");
  assert.equal(joined.includes("fake-key-for-test"), false, "[AI prompt] 日志严禁含 apiKey 字面量");
});

test("多次 AI 调用产生的日志每行只有一个时间戳（不重复）", async (t) => {
  const spy = installConsoleSpy();
  t.after(() => spy.restore());
  const validReply = {
    reply: "已生成。",
    patch: [{ op: "add", path: "/basicInfo/subtitle", value: "太原" }],
    questions: [],
    researchTasks: [],
  };
  const service = await bootService(t, (res) => { res.setHeader("content-type", "application/json"); res.end(okToolCallResponse("submit_product_update", validReply)); });
  await service.testConnection();
  await service.reply({ message: "生成第一版", product: { basicInfo: { meetingCity: "太原" }, itinerary: [] }, history: [] });
  // 每条 console 输出首参都应只出现一个 YYYY-MM-DD HH:MM:SS.SSS 时间戳。
  for (const entry of spy.logs) {
    const head = entry.args[0];
    if (typeof head !== "string") continue;
    const stamps = head.match(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}/g) ?? [];
    assert.equal(stamps.length, 1, `一行日志不应出现多个时间戳：head=${head.slice(0, 200)}`);
  }
});