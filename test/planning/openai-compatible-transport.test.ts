/**
 * OpenAI 兼容 planning adapter 的传输层契约测试：
 *
 *  - MiniMax / DeepSeek 两个 provider 必须把 provider-specific 参数映射成显式
 *    HTTP 请求 body，不能在源码字符串层面对拼装结果做 grep 断言；
 *  - OpenAI SDK 抛出的连接 / 鉴权 / 限流 / 超时 / 5xx 等常见错误必须被
 *    normaliseTransportError 归一化为 orchestrator 能识别的 PlannerError code，
 *    且 details 字段必须保留原 error 信息；
 *  - adapter 内置的硬超时必须有界（短超时即返回，不挂死）；
 *  - 测试只走真实 http.createServer，不使用任何 mock 框架。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { OpenAICompatiblePlannerAdapter, planningTransportOptions, normaliseTransportError } from "../../src/main/planning/adapters/openai-compatible-adapter.js";
import { OpenAIThreeStagePlanningAi } from "../../src/main/planning/adapters/three-stage-ai.js";
import { PlannerError } from "../../src/shared/contracts-planning.js";
import type { PlannerRequest, PoiNameResolutionRequest } from "../../src/shared/contracts-planning.js";

// ───────────────────────── helpers ─────────────────────────

interface CapturedRequest {
  method: string;
  url: string;
  authHeader: string | undefined;
  contentType: string | undefined;
  body: string;
  parsedBody: Record<string, unknown>;
}

interface ServerHandle {
  url: string;
  captured: CapturedRequest[];
  close: () => Promise<void>;
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

async function startCapturingServer(
  t: test.TestContext,
  respond: (req: CapturedRequest, res: ServerResponse) => void,
): Promise<ServerHandle> {
  const captured: CapturedRequest[] = [];
  const server = createServer(async (request, response) => {
    try {
      const raw = await readBody(request);
      const parsed = raw ? JSON.parse(raw) as Record<string, unknown> : {};
      const entry: CapturedRequest = {
        method: request.method ?? "GET",
        url: request.url ?? "/",
        authHeader: typeof request.headers.authorization === "string" ? request.headers.authorization : undefined,
        contentType: typeof request.headers["content-type"] === "string" ? request.headers["content-type"] : undefined,
        body: raw,
        parsedBody: parsed,
      };
      captured.push(entry);
      respond(entry, response);
    } catch (error) {
      response.statusCode = 500;
      response.end(JSON.stringify({ error: { message: (error as Error).message } }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    captured,
    close: async () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function okToolCallResponse(name: string, args: unknown): string {
  return JSON.stringify({
    choices: [{
      message: {
        content: null,
        tool_calls: [{ id: "call_x", type: "function", function: { name, arguments: JSON.stringify(args) } }],
      },
    }],
  });
}

const baseSkeleton = { destination: "太原", days: 2, nights: 1, productForm: "privateTour" as const, productType: "domesticShort" as const, supplierProductCode: "NEW" };

function basicInfoRequest(): PlannerRequest {
  return {
    stage: "basicInfo",
    context: {
      skeleton: baseSkeleton,
      acceptedModules: [],
      existingResearchTasks: [],
      currentProduct: { basicInfo: {} },
    },
  };
}

function poiNameRequest(): PoiNameResolutionRequest {
  return { destination: "西安", originalName: "钟楼", attempt: 1, previousCandidates: [] };
}

test("ThreeStage 第一阶段通过结构化工具返回省市，并把上一轮准入失败反馈给 AI", async (t) => {
  const server = await startCapturingServer(t, (_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(okToolCallResponse("submit_standard_location", { province: "西藏", destinationCity: "拉萨" }));
  });
  const ai = new OpenAIThreeStagePlanningAi({
    apiKey: "location-test-key",
    baseUrl: server.url,
    model: "location-model",
    provider: "test-provider",
  });
  const location = await ai.structureLocation({
    destination: "西藏自治区",
    previousError: "第一阶段目的地准入失败：destinationCity 为空",
  });
  assert.deepEqual(location, { province: "西藏", destinationCity: "拉萨" });
  assert.equal(server.captured.length, 1);
  const request = server.captured[0].parsedBody;
  assert.equal(request.model, "location-model");
  assert.equal((request.tools as Array<{ function: { name: string } }>)[0].function.name, "submit_standard_location");
  assert.match(String((request.messages as Array<{ content: string }>)[0].content), /全球旅游产品/);
  assert.match(String((request.messages as Array<{ content: string }>)[0].content), /境外目的地/);
  assert.match(String((request.messages as Array<{ content: string }>)[1].content), /destinationCity 为空/);
});

// ───────────────────────── transport param mapping ─────────────────────────

test("MiniMax 请求 body 含 thinking/reasoning_split/service_tier，Authorization 正确", async (t) => {
  const prevTier = process.env.MINIMAX_SERVICE_TIER;
  process.env.MINIMAX_SERVICE_TIER = "standard";
  t.after(() => { if (prevTier === undefined) delete process.env.MINIMAX_SERVICE_TIER; else process.env.MINIMAX_SERVICE_TIER = prevTier; });
  const server = await startCapturingServer(t, (_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(okToolCallResponse("submit_basicInfo_module", {
      reply: "ok",
      modules: [{ module: "basicInfo", status: "accepted", value: { subtitle: "太原精华之旅", province: "山西", operationNotes: "待核查" } }],
    }));
  });
  const adapter = new OpenAICompatiblePlannerAdapter({
    apiKey: "test-minimax-key",
    baseUrl: server.url,
    model: "MiniMax-M3",
    ...planningTransportOptions("minimax"),
  });
  await adapter.generateStage(basicInfoRequest());
  assert.equal(server.captured.length, 1);
  const captured = server.captured[0];
  assert.equal(captured.method, "POST");
  assert.match(captured.url ?? "", /\/chat\/completions/);
  assert.equal(captured.authHeader, "Bearer test-minimax-key");
  assert.match(captured.contentType ?? "", /application\/json/);
  assert.equal(captured.parsedBody.model, "MiniMax-M3");
  assert.deepEqual(captured.parsedBody.thinking, { type: "disabled" });
  assert.equal(captured.parsedBody.reasoning_split, true);
  assert.equal(captured.parsedBody.service_tier, "standard");
});

test("MINIMAX_SERVICE_TIER=priority 时透传 priority", async (t) => {
  const prevTier = process.env.MINIMAX_SERVICE_TIER;
  process.env.MINIMAX_SERVICE_TIER = "priority";
  t.after(() => { if (prevTier === undefined) delete process.env.MINIMAX_SERVICE_TIER; else process.env.MINIMAX_SERVICE_TIER = prevTier; });
  const server = await startCapturingServer(t, (_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(okToolCallResponse("submit_basicInfo_module", { reply: "ok", modules: [{ module: "basicInfo", status: "accepted", value: { subtitle: "太原精华之旅", province: "山西", operationNotes: "待核查" } }] }));
  });
  const adapter = new OpenAICompatiblePlannerAdapter({
    apiKey: "k", baseUrl: server.url, model: "MiniMax-M3",
    ...planningTransportOptions("minimax"),
  });
  await adapter.generateStage(basicInfoRequest());
  assert.equal(server.captured[0].parsedBody.service_tier, "priority");
});

test("DeepSeek 请求 body 不携带 MiniMax 专有字段（thinking/reasoning_split/service_tier）", async (t) => {
  const server = await startCapturingServer(t, (_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(okToolCallResponse("submit_basicInfo_module", { reply: "ok", modules: [{ module: "basicInfo", status: "accepted", value: { subtitle: "太原精华之旅", province: "山西", operationNotes: "待核查" } }] }));
  });
  const adapter = new OpenAICompatiblePlannerAdapter({
    apiKey: "test-deepseek-key",
    baseUrl: server.url,
    model: "deepseek-v4-flash",
    ...planningTransportOptions("deepseek"),
  });
  await adapter.generateStage(basicInfoRequest());
  const body = server.captured[0].parsedBody;
  assert.equal(body.model, "deepseek-v4-flash");
  assert.equal(body.thinking, undefined, "DeepSeek 请求 body 不应包含 thinking");
  assert.equal(body.reasoning_split, undefined, "DeepSeek 请求 body 不应包含 reasoning_split");
  assert.equal(body.service_tier, undefined, "DeepSeek 请求 body 不应包含 service_tier");
});

test("resolvePoiName 也按 provider 注入对应 extraParams（MiniMax 走 disabled thinking）", async (t) => {
  const server = await startCapturingServer(t, (_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(okToolCallResponse("submit_vbk_poi_name", { poiName: "西安钟楼" }));
  });
  const adapter = new OpenAICompatiblePlannerAdapter({
    apiKey: "k", baseUrl: server.url, model: "MiniMax-M3",
    ...planningTransportOptions("minimax"),
  });
  const result = await adapter.resolvePoiName(poiNameRequest());
  assert.equal(result, "西安钟楼");
  const body = server.captured[0].parsedBody;
  assert.deepEqual(body.thinking, { type: "disabled" });
  assert.equal(body.reasoning_split, true);
  assert.equal(body.service_tier, "standard");
});

// ───────────────────────── error mapping ─────────────────────────

test("HTTP 401 映射为 provider_authentication，details 保留 status 与 message", async (t) => {
  const server = await startCapturingServer(t, (_req, res) => {
    res.statusCode = 401;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: { message: "Incorrect API key provided.", type: "authentication_error", code: "invalid_api_key" } }));
  });
  const adapter = new OpenAICompatiblePlannerAdapter({ apiKey: "bad", baseUrl: server.url, model: "m" });
  await assert.rejects(
    adapter.generateStage(basicInfoRequest()),
    (err: unknown) => err instanceof PlannerError
      && err.code === "provider_authentication"
      && typeof err.details === "string"
      && err.details.includes("status=401"),
  );
});

test("HTTP 403 映射为 provider_authentication", async (t) => {
  const server = await startCapturingServer(t, (_req, res) => {
    res.statusCode = 403;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: { message: "Forbidden", type: "permission_error", code: "forbidden" } }));
  });
  const adapter = new OpenAICompatiblePlannerAdapter({ apiKey: "k", baseUrl: server.url, model: "m" });
  await assert.rejects(
    adapter.generateStage(basicInfoRequest()),
    (err: unknown) => err instanceof PlannerError && err.code === "provider_authentication",
  );
});

test("HTTP 429 映射为 provider_rate_limit", async (t) => {
  const server = await startCapturingServer(t, (_req, res) => {
    res.statusCode = 429;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: { message: "Rate limit reached", type: "rate_limit_error", code: "rate_limit_exceeded" } }));
  });
  const adapter = new OpenAICompatiblePlannerAdapter({ apiKey: "k", baseUrl: server.url, model: "m" });
  await assert.rejects(
    adapter.generateStage(basicInfoRequest()),
    (err: unknown) => err instanceof PlannerError
      && err.code === "provider_rate_limit"
      && typeof err.details === "string"
      && err.details.includes("status=429"),
  );
});

test("HTTP 5xx 映射为 provider_connection（message 带状态码）", async (t) => {
  const server = await startCapturingServer(t, (_req, res) => {
    res.statusCode = 502;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: { message: "Bad gateway" } }));
  });
  const adapter = new OpenAICompatiblePlannerAdapter({ apiKey: "k", baseUrl: server.url, model: "m" });
  await assert.rejects(
    adapter.generateStage(basicInfoRequest()),
    (err: unknown) => err instanceof PlannerError
      && err.code === "provider_connection"
      && err.message.includes("HTTP 502"),
  );
});

test("HTTP 500 同样归 provider_connection（服务异常归到连接类）", async (t) => {
  const server = await startCapturingServer(t, (_req, res) => {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: { message: "Internal Server Error" } }));
  });
  const adapter = new OpenAICompatiblePlannerAdapter({ apiKey: "k", baseUrl: server.url, model: "m" });
  await assert.rejects(
    adapter.generateStage(basicInfoRequest()),
    (err: unknown) => err instanceof PlannerError && err.code === "provider_connection",
  );
});

test("连接被拒（端口未监听）映射为 provider_connection", async (t) => {
  // 不启动任何 server；adapter 直接打一个不可能连通的端口。
  const deadUrl = "http://127.0.0.1:1/v1"; // RFC 6335 reserved port, 不会监听
  const adapter = new OpenAICompatiblePlannerAdapter({
    apiKey: "k",
    baseUrl: deadUrl,
    model: "m",
    timeoutMs: 5_000,
  });
  await assert.rejects(
    adapter.generateStage(basicInfoRequest()),
    (err: unknown) => err instanceof PlannerError && err.code === "provider_connection",
  );
});

test("请求长时间挂起会被硬超时截断为 provider_timeout，不超过 timeoutMs+1s 释放", async (t) => {
  // 服务只挂连接不返回任何 body，OpenAI SDK timeout=400ms + adapter hardTimeout=300ms。
  const server = await startCapturingServer(t, () => {
    // intentionally never call res.end()
  });
  const adapter = new OpenAICompatiblePlannerAdapter({
    apiKey: "k",
    baseUrl: server.url,
    model: "m",
    timeoutMs: 300,
  });
  const start = Date.now();
  await assert.rejects(
    adapter.generateStage(basicInfoRequest()),
    (err: unknown) => err instanceof PlannerError && err.code === "provider_timeout",
  );
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 4_000, `硬超时必须 bounded，实际耗时 ${elapsed}ms`);
  // 强制让 server 关闭，否则 unhandled socket 会让测试进程延迟退出。
  await server.close();
});

test("normaliseTransportError 把 PlannerError 原样返回（不会重复包装）", () => {
  const original = new PlannerError("provider_rate_limit", "原提示");
  const result = normaliseTransportError(original);
  assert.equal(result, original);
});

test("normaliseTransportError 把非 SDK Error 的 status=401 字符串异常映射到 provider_authentication", () => {
  const err = Object.assign(new Error("proxy said unauthorized"), { status: 401 });
  const result = normaliseTransportError(err);
  assert.equal(result.code, "provider_authentication");
  assert.ok((result.details ?? "").includes("status=401"));
});

test("normaliseTransportError 把非 SDK Error 的 status=502 映射到 provider_connection", () => {
  const err = Object.assign(new Error("upstream 502"), { status: 502 });
  const result = normaliseTransportError(err);
  assert.equal(result.code, "provider_connection");
  assert.ok((result.details ?? "").includes("status=502"));
});

test("normaliseTransportError 兜底 unknown 仍带原 message", () => {
  const err = new Error("weird stuff");
  const result = normaliseTransportError(err);
  assert.equal(result.code, "unknown");
  assert.equal(result.message, "weird stuff");
});
