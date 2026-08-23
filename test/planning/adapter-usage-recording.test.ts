import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { OpenAICompatiblePlannerAdapter } from "../../src/main/planning/adapters/openai-compatible-adapter.js";
import { OpenAIThreeStagePlanningAi } from "../../src/main/planning/adapters/three-stage-ai.js";
import { PlannerError } from "../../src/shared/contracts-planning.js";
import type { AiUsageEvent } from "../../src/shared/contracts-ai-usage.js";
import type { PlannerRequest } from "../../src/shared/contracts-planning.js";

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

async function startServer(
  t: test.TestContext,
  respond: (res: ServerResponse) => void,
): Promise<string> {
  const server = createServer(async (request, response) => {
    await readBody(request);
    respond(response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}/v1`;
}

function toolResponse(name: string, args: unknown, usage?: Record<string, number>) {
  return JSON.stringify({
    choices: [{
      message: {
        tool_calls: [{ type: "function", function: { name, arguments: JSON.stringify(args) } }],
      },
    }],
    usage: usage ?? { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 },
  });
}

function basicInfoRequest(): PlannerRequest {
  return {
    stage: "basicInfo",
    context: {
      skeleton: {
        destination: "太原",
        days: 2,
        nights: 1,
        productForm: "privateTour",
        productType: "domesticShort",
        supplierProductCode: "SUP-1",
      },
      currentProduct: { basicInfo: { destination: "太原", days: 2 } },
      acceptedModules: [],
      existingResearchTasks: [],
      history: [],
      transport: { providerLabel: "MiniMax", model: "m" },
    },
  };
}

test("generateStage 成功时记录 presentation/basicInfo stage 的 input+output tokens", async (t) => {
  const events: AiUsageEvent[] = [];
  const url = await startServer(t, (res) => {
    res.setHeader("content-type", "application/json");
    res.end(toolResponse("submit_basicInfo_module", {
      reply: "ok",
      modules: [{ module: "basicInfo", status: "accepted", value: { subtitle: "太原精华", province: "山西", operationNotes: "待核查" } }],
    }, { prompt_tokens: 21, completion_tokens: 9, total_tokens: 30 }));
  });
  const adapter = new OpenAICompatiblePlannerAdapter({
    apiKey: "k",
    baseUrl: url,
    model: "m",
    provider: "minimax",
    recordUsage: (event) => events.push(event),
  }).withUsageScope({ localProductId: "prod-1", runId: "run-1" });

  await adapter.generateStage(basicInfoRequest());

  assert.equal(events.length, 1);
  assert.equal(events[0].source, "planning.generateStage");
  assert.equal(events[0].stage, "basicInfo");
  assert.equal(events[0].status, "ok");
  assert.equal(events[0].inputTokens, 21);
  assert.equal(events[0].outputTokens, 9);
  assert.equal(events[0].totalTokens, 30);
  assert.equal(events[0].runId, "run-1");
  assert.equal(events[0].model, "m");
  assert.doesNotMatch(JSON.stringify(events[0]), /apiKey|Bearer |cookie/i);
});

test("generateStage 超时仍记录 error 事件与 durationMs", async (t) => {
  const events: AiUsageEvent[] = [];
  const url = await startServer(t, () => {
    // never respond
  });
  const adapter = new OpenAICompatiblePlannerAdapter({
    apiKey: "k",
    baseUrl: url,
    model: "m",
    timeoutMs: 200,
    recordUsage: (event) => events.push(event),
  });
  await assert.rejects(
    adapter.generateStage(basicInfoRequest()),
    (err: unknown) => err instanceof PlannerError && err.code === "provider_timeout",
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].status, "error");
  assert.equal(events[0].errorCode, "provider_timeout");
  assert.ok(events[0].durationMs >= 0);
});

test("ThreeStage.structureLocation 记录 planning.structureLocation", async (t) => {
  const events: AiUsageEvent[] = [];
  const url = await startServer(t, (res) => {
    res.setHeader("content-type", "application/json");
    res.end(toolResponse("submit_standard_location", {
      province: "四川",
      destinationCity: "成都",
    }));
  });
  const ai = new OpenAIThreeStagePlanningAi({
    apiKey: "k",
    baseUrl: url,
    model: "m",
    provider: "minimax",
    recordUsage: (event) => events.push(event),
  }).withUsageScope({ localProductId: "prod-1", runId: "run-9" });

  const location = await ai.structureLocation({ destination: "成都", previousError: undefined });
  assert.equal(location.province, "四川");
  assert.equal(events.length, 1);
  assert.equal(events[0].source, "planning.structureLocation");
  assert.equal(events[0].inputTokens, 11);
  assert.equal(events[0].outputTokens, 4);
  assert.equal(events[0].runId, "run-9");
});
