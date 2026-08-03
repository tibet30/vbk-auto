import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { MiniMaxService, MiniMaxServiceError } from "../src/main/minimax.js";

test("通用产品方案模型响应会被解析为安全的草稿更新", async (t) => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      choices: [{ message: { content: `<think>先确认产品约束，再生成安全草稿。</think>\n\n以下是结果：\n\n\`\`\`json\n${JSON.stringify({
        reply: "已生成太原2天1晚私家团第一版。",
        patch: [{ op: "add", path: "/basicInfo/subtitle", value: "晋阳古都文化体验·专车私享" }],
        researchTasks: [{ label: "核查用车资源组", type: "vbk", detail: "在 VBK 资源库确认有效资源组 ID" }],
      })}\n\`\`\`` } }],
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const service = new MiniMaxService({ apiKey: "test-key", baseUrl: `http://127.0.0.1:${address.port}/v1`, model: "test-model" });

  const result = await service.reply({ message: "生成第一版", product: { basicInfo: { meetingCity: "太原" }, itinerary: [] }, history: [] });

  assert.equal(result.reply, "已生成太原2天1晚私家团第一版。");
  assert.deepEqual(result.patch?.[0], { op: "add", path: "/basicInfo/subtitle", value: "晋阳古都文化体验·专车私享" });
  assert.equal(result.researchTasks?.[0].label, "核查用车资源组");
});

test("模型响应被常见外层字段包裹时仍可解析", async (t) => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        result: {
          reply: "已生成太原2天1晚私家团第一版。",
          patch: [{ op: "add", path: "/itinerary", value: [{ day: 1, title: "太原接站—晋祠", spots: ["晋祠"], description: "专车接站后游览晋祠。", hotel: "太原市区酒店", meals: "敬请自理" }] }],
          researchTasks: [{ label: "核查门票预约", type: "web", detail: "确认晋祠开放时间与预约要求" }],
        },
      }) } }],
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  const service = new MiniMaxService({ apiKey: "test-key", baseUrl: `http://127.0.0.1:${address.port}/v1`, model: "test-model" });
  const result = await service.reply({ message: "生成第一版", product: { basicInfo: { meetingCity: "太原" }, itinerary: [] }, history: [] });

  assert.equal(result.reply, "已生成太原2天1晚私家团第一版。");
  assert.equal(result.patch?.[0].path, "/itinerary");
  assert.equal(result.researchTasks?.[0].label, "核查门票预约");
});

test("模型通过工具调用返回时会直接解析为产品更新", async (t) => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      choices: [{
        message: {
          content: null,
          tool_calls: [{
            id: "call_1",
            type: "function",
            function: {
              name: "submit_product_update",
              arguments: JSON.stringify({
                reply: "已按上一轮要求缩短行程节奏。",
                patch: [{ op: "replace", path: "/basicInfo/subtitle", value: "轻松慢游·专车私享" }],
                questions: [],
                researchTasks: [],
              }),
            },
          }],
        },
      }],
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  const service = new MiniMaxService({ apiKey: "test-key", baseUrl: `http://127.0.0.1:${address.port}/v1`, model: "test-model" });
  const result = await service.reply({
    message: "第二天不要太赶",
    product: { basicInfo: { meetingCity: "太原" }, itinerary: [{ day: 1 }, { day: 2 }] },
    history: [{ role: "user", content: "生成第一版" }, { role: "assistant", content: "已生成第一版。" }],
  });

  assert.equal(result.reply, "已按上一轮要求缩短行程节奏。");
  assert.deepEqual(result.patch?.[0], { op: "replace", path: "/basicInfo/subtitle", value: "轻松慢游·专车私享" });
});

test("模型返回不可写 patch 路径时会被本地结构校验丢弃", async (t) => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        reply: "已设置价格。",
        patch: [{ op: "add", path: "/commercial/pricing", value: { publicPrice: 1999 } }],
        questions: [],
        researchTasks: [],
      }) } }],
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  const service = new MiniMaxService({ apiKey: "test-key", baseUrl: `http://127.0.0.1:${address.port}/v1`, model: "test-model" });
  const result = await service.reply({ message: "补价格", product: { basicInfo: { meetingCity: "太原" }, itinerary: [] }, history: [] });

  assert.equal(result.reply, "已设置价格。");
  assert.deepEqual(result.patch, []);
});

test("连接测试会发出轻量 MiniMax 请求", async (t) => {
  let requestBody = "";
  const server = createServer((request, response) => {
    request.on("data", (chunk) => { requestBody += String(chunk); });
    request.on("end", () => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ choices: [{ message: { content: "pong" } }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  await new MiniMaxService({ apiKey: "test-key", baseUrl: `http://127.0.0.1:${address.port}/v1`, model: "test-model" }).testConnection();
  const parsedBody = JSON.parse(requestBody) as Record<string, unknown>;
  assert.equal(parsedBody.max_completion_tokens, 1);
  assert.deepEqual(parsedBody.thinking, { type: "disabled" });
  assert.equal(parsedBody.extra_body, undefined);
});

test("方案生成请求会给完整 JSON 草稿预留足够输出额度", async (t) => {
  let requestBody = "";
  const server = createServer((request, response) => {
    request.on("data", (chunk) => { requestBody += String(chunk); });
    request.on("end", () => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ reply: "ok", patch: [{ op: "add", path: "/itinerary", value: [{ day: 1, title: "太原一日", spots: [], description: "", hotel: "", meals: "" }] }], questions: [], researchTasks: [] }) } }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  await new MiniMaxService({ apiKey: "test-key", baseUrl: `http://127.0.0.1:${address.port}/v1`, model: "test-model" }).reply({ message: "生成第一版", product: { basicInfo: { meetingCity: "太原" }, itinerary: [] }, history: [] });

  const parsedBody = JSON.parse(requestBody) as Record<string, unknown>;
  assert.equal(parsedBody.max_completion_tokens, 2048);
  assert.ok(Array.isArray(parsedBody.tools));
  assert.equal((parsedBody.tool_choice as { function?: { name?: string } }).function?.name, "submit_product_update");
  assert.deepEqual(parsedBody.thinking, { type: "disabled" });
  assert.equal(parsedBody.reasoning_split, true);
  assert.equal(parsedBody.service_tier, "standard");
  assert.equal(parsedBody.extra_body, undefined);
  const tool = (parsedBody.tools as Array<{ function: { parameters: { properties: { patch: { items: { properties: { path: { enum: string[] } } } } } } } }>)[0];
  assert.ok(tool.function.parameters.properties.patch.items.properties.path.enum.includes("/itinerary"));
  assert.equal(tool.function.parameters.properties.patch.items.properties.path.enum.includes("/basicInfo/productTitle"), false);
});

test("首次生成没有返回可写字段时不会被误判为成功", async (t) => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ reply: "已生成方案。", patch: [], questions: [], researchTasks: [] }) } }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  const service = new MiniMaxService({ apiKey: "test-key", baseUrl: `http://127.0.0.1:${address.port}/v1`, model: "test-model" });
  await assert.rejects(
    service.reply({ message: "生成第一版", product: { itinerary: [] }, history: [] }),
    (error: unknown) => error instanceof Error && error.message === "MiniMax 未返回可写入的产品方案，请重试。",
  );
});

test("空草稿首次生成时不会被历史中的假成功回复误导", async (t) => {
  let requestBody = "";
  const server = createServer((request, response) => {
    request.on("data", (chunk) => { requestBody += String(chunk); });
    request.on("end", () => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        reply: "已重新生成第一版。",
        patch: [{ op: "add", path: "/itinerary", value: [{ day: 1, title: "太原一日", spots: [], description: "", hotel: "", meals: "" }] }],
        questions: [],
        researchTasks: [],
      }) } }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  const service = new MiniMaxService({ apiKey: "test-key", baseUrl: `http://127.0.0.1:${address.port}/v1`, model: "test-model" });
  await service.reply({
    message: "生成第一版",
    product: { basicInfo: { meetingCity: "太原" }, itinerary: [] },
    history: [{ role: "assistant", content: "已经生成完整方案。" }],
  });

  const messages = (JSON.parse(requestBody) as { messages: Array<{ content: string }> }).messages;
  assert.equal(messages.some((message) => message.content === "已经生成完整方案。"), false);
});

test("MiniMax 常见展示和行程字段会转换为产品草稿协议", async (t) => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      reply: "已生成方案。",
      patch: [
        { op: "add", path: "/presentation", value: { productName: "太原私家团", subtitle: "晋阳古韵", highlights: ["专车服务", "纯玩无购物"], description: "两天探访三晋文化。" } },
        { op: "add", path: "/itinerary", value: [{ day: 1, title: "晋祠探古", summary: "游览晋祠", activities: [{ time: "上午", name: "晋祠博物馆", detail: "参观古建筑" }], meals: { breakfast: "自理", lunch: "自理", dinner: "自理" }, stay: "太原市区酒店" }] },
      ],
      questions: [],
      researchTasks: [],
    }) } }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  const service = new MiniMaxService({ apiKey: "test-key", baseUrl: `http://127.0.0.1:${address.port}/v1`, model: "test-model" });
  const result = await service.reply({ message: "生成第一版", product: { itinerary: [] }, history: [] });

  assert.deepEqual(result.patch?.[0].value, {
    recommendationCategory: "优选行程",
    recommendation: "两天探访三晋文化。",
    features: "专车服务\n纯玩无购物",
  });
  assert.deepEqual(result.patch?.[1].value, [{
    day: 1,
    title: "晋祠探古",
    spots: ["晋祠博物馆"],
    description: "游览晋祠。上午 晋祠博物馆 参观古建筑",
    hotel: "太原市区酒店",
    meals: "早餐自理；午餐自理；晚餐自理",
    mealDescriptions: ["早餐自理", "午餐自理", "晚餐自理"],
    hotelDescription: "太原市区酒店",
    activities: [{ time: "上午", title: "晋祠博物馆", detail: "参观古建筑", type: "other" }],
  }]);
});

test("结构字段中的待核查占位值不会写入产品草稿", async (t) => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      reply: "运营字段待核查。",
      patch: [
        { op: "replace", path: "/operations/transport", value: "待核查" },
        { op: "replace", path: "/operations/reusePickupForDropoff", value: null },
        { op: "replace", path: "/commercial/packageName", value: "" },
      ],
      questions: [],
      researchTasks: [{ label: "核查车辆资源", type: "vbk" }],
    }) } }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  const service = new MiniMaxService({ apiKey: "test-key", baseUrl: `http://127.0.0.1:${address.port}/v1`, model: "test-model" });
  const result = await service.reply({ message: "补充运营字段", product: { itinerary: [{ day: 1 }] }, history: [] });

  assert.deepEqual(result.patch, []);
  assert.equal(result.researchTasks?.[0].label, "核查车辆资源");
});

type DiagnosisPayload = {
  summary: string;
  rootCause: string;
  action: string;
  expectedEvidence: string;
  userInstruction?: string;
  [key: string]: unknown;
};

const validDiagnosis: DiagnosisPayload = {
  summary: "基础信息可能未真正落库。",
  rootCause: "保存动作返回失败，现有证据无法确认基础信息已保存。",
  action: "retry_same_phase",
  expectedEvidence: "重试成功后基本信息显示已保存，且产品图文 tab 可点击。",
};

const diagnosisInput = {
  phase: "basic",
  attempt: 1,
  error: "保存失败：原因未知",
  productIdExists: true,
  basicInfoSaved: false,
  completedPhases: ["shell"],
  diagnosisHistory: [{
    summary: "上次保存可能未完成。",
    rootCause: "保存结果未出现成功证据。",
    action: "reload_and_retry_phase" as const,
    expectedEvidence: "刷新重试后出现保存成功提示。",
  }],
};

function sendDiagnosis(response: ServerResponse, payload: DiagnosisPayload | string): void {
  const argumentsValue = typeof payload === "string" ? payload : JSON.stringify(payload);
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({
    responseMarker: "raw-response-canary",
    choices: [{ message: { content: null, tool_calls: [{
      id: "call_diagnosis",
      type: "function",
      function: { name: "submit_failure_diagnosis", arguments: argumentsValue },
    }] } }],
  }));
}

async function createDiagnosisService(
  t: TestContext,
  respond: (response: ServerResponse) => void,
): Promise<{ service: MiniMaxService; requestBody: () => string }> {
  let body = "";
  const server = createServer((request, response) => {
    request.on("data", (chunk) => { body += String(chunk); });
    request.on("end", () => respond(response));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    service: new MiniMaxService({ apiKey: "test-key", baseUrl: `http://127.0.0.1:${address.port}/v1`, model: "test-model" }),
    requestBody: () => body,
  };
}

function hasMiniMaxCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof MiniMaxServiceError && error.code === code;
}

test("diagnoseAutomationFailure 严格解析白名单诊断并只发送最小安全上下文", async (t) => {
  const { service, requestBody } = await createDiagnosisService(t, (response) => sendDiagnosis(response, validDiagnosis));
  const unsafeInput = {
    ...diagnosisInput,
    providerId: 9988,
    phone: "13800138000",
    currentUrl: "https://example.invalid/editor",
    product: { pricing: { adult: 9999 } },
  };

  const outcome = await service.diagnoseAutomationFailure(unsafeInput);

  assert.deepEqual(outcome, validDiagnosis);
  const body = JSON.parse(requestBody()) as {
    messages: Array<{ role: string; content: string }>;
    tools: Array<{ function: { name: string; parameters: Record<string, unknown> } }>;
    tool_choice: { function: { name: string } };
    max_completion_tokens: number;
    thinking: unknown;
    service_tier: string;
  };
  assert.equal(body.tools[0]?.function.name, "submit_failure_diagnosis");
  assert.equal(body.tool_choice.function.name, "submit_failure_diagnosis");
  assert.equal(body.max_completion_tokens, 1024);
  assert.deepEqual(body.thinking, { type: "disabled" });
  assert.equal(body.service_tier, "standard");

  const userPrompt = body.messages.find((message) => message.role === "user")?.content ?? "";
  const context = JSON.parse(userPrompt.slice(userPrompt.indexOf("{") )) as Record<string, unknown>;
  assert.deepEqual(Object.keys(context).sort(), [
    "attempt", "basicInfoSaved", "completedPhases", "diagnosisHistory", "error", "phase", "productIdExists",
  ]);
  assert.equal(context.providerId, undefined);
  assert.equal(context.phone, undefined);
  assert.equal(context.currentUrl, undefined);
  assert.equal(context.product, undefined);

  const prompt = body.messages.map((message) => message.content).join("\n");
  for (const field of ["phase", "attempt", "error", "productIdExists", "basicInfoSaved", "completedPhases", "diagnosisHistory"]) {
    assert.match(prompt, new RegExp(field));
  }
  for (const forbidden of ["代码", "选择器", "URL", "DOM", "cookie", "key", "联系人", "电话", "完整产品JSON", "图片", "providerId", "提审", "发布", "上线", "删除", "库存", "价格"]) {
    assert.ok(prompt.includes(forbidden), `提示词应明确禁止 ${forbidden}`);
  }
  assert.match(prompt, /唯一 action/);
  assert.match(prompt, /summary.*中文.*80/s);
  assert.match(prompt, /rootCause.*中文.*200/s);
  assert.match(prompt, /expectedEvidence.*中文.*120/s);
  assert.match(prompt, /expectedEvidence.*重试成功.*证据/s);
  assert.match(prompt, /wait_for_user.*userInstruction.*必填/s);
  assert.match(prompt, /其它 action.*忽略 userInstruction/s);
});

test("diagnoseAutomationFailure 拒绝含额外字段的诊断", async (t) => {
  const { service } = await createDiagnosisService(t, (response) => sendDiagnosis(response, {
    ...validDiagnosis,
    hint: "raw-tool-arguments-canary",
    remediationCode: "R-1",
  }));

  await assert.rejects(service.diagnoseAutomationFailure(diagnosisInput), hasMiniMaxCode("invalid_model_output"));
});

for (const illegalAction of ["please_call_user", "generate_patch"]) {
  test(`diagnoseAutomationFailure 拒绝非法 action：${illegalAction}`, async (t) => {
    const { service } = await createDiagnosisService(t, (response) => sendDiagnosis(response, { ...validDiagnosis, action: illegalAction }));

    await assert.rejects(service.diagnoseAutomationFailure(diagnosisInput), hasMiniMaxCode("invalid_model_output"));
  });
}

test("diagnoseAutomationFailure 要求 wait_for_user 提供非空 userInstruction", async (t) => {
  const missing = await createDiagnosisService(t, (response) => sendDiagnosis(response, { ...validDiagnosis, action: "wait_for_user" }));
  await assert.rejects(missing.service.diagnoseAutomationFailure(diagnosisInput), hasMiniMaxCode("invalid_model_output"));

  const blank = await createDiagnosisService(t, (response) => sendDiagnosis(response, { ...validDiagnosis, action: "wait_for_user", userInstruction: "   " }));
  await assert.rejects(blank.service.diagnoseAutomationFailure(diagnosisInput), hasMiniMaxCode("invalid_model_output"));
});

test("diagnoseAutomationFailure 保留 wait_for_user 指令并忽略其它 action 的 userInstruction", async (t) => {
  const waiting = await createDiagnosisService(t, (response) => sendDiagnosis(response, {
    ...validDiagnosis,
    action: "wait_for_user",
    userInstruction: "请在 VBK 确认账号仍处于登录状态，然后重新保存草稿。",
  }));
  const waitingOutcome = await waiting.service.diagnoseAutomationFailure(diagnosisInput);
  assert.equal(waitingOutcome.userInstruction, "请在 VBK 确认账号仍处于登录状态，然后重新保存草稿。");

  const retrying = await createDiagnosisService(t, (response) => sendDiagnosis(response, {
    ...validDiagnosis,
    userInstruction: "   ",
  }));
  const retryingOutcome = await retrying.service.diagnoseAutomationFailure(diagnosisInput);
  assert.equal(retryingOutcome.userInstruction, undefined);
  assert.deepEqual(Object.keys(retryingOutcome).sort(), ["action", "expectedEvidence", "rootCause", "summary"]);
});

test("diagnoseAutomationFailure 执行本地文本长度限制", async (t) => {
  const overlongPayloads: DiagnosisPayload[] = [
    { ...validDiagnosis, summary: "假".repeat(81) },
    { ...validDiagnosis, rootCause: "因".repeat(201) },
    { ...validDiagnosis, expectedEvidence: "证".repeat(121) },
  ];

  for (const payload of overlongPayloads) {
    const { service } = await createDiagnosisService(t, (response) => sendDiagnosis(response, payload));
    await assert.rejects(service.diagnoseAutomationFailure(diagnosisInput), hasMiniMaxCode("invalid_model_output"));
  }
});

test("diagnoseAutomationFailure 拒绝非中文诊断字段", async (t) => {
  const invalidPayloads: DiagnosisPayload[] = [
    { ...validDiagnosis, summary: "retry failed" },
    { ...validDiagnosis, rootCause: "request failed without evidence" },
    { ...validDiagnosis, expectedEvidence: "saved successfully" },
    { ...validDiagnosis, action: "wait_for_user", userInstruction: "check the page" },
  ];

  for (const payload of invalidPayloads) {
    const { service } = await createDiagnosisService(t, (response) => sendDiagnosis(response, payload));
    await assert.rejects(service.diagnoseAutomationFailure(diagnosisInput), hasMiniMaxCode("invalid_model_output"));
  }
});

test("diagnoseAutomationFailure 将 provider 401 映射为 provider_authentication", async (t) => {
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args); };
  t.after(() => { console.warn = originalWarn; });
  const { service } = await createDiagnosisService(t, (response) => {
    response.statusCode = 401;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ error: { message: "invalid key", type: "authentication_error", code: "invalid_api_key" } }));
  });

  await assert.rejects(service.diagnoseAutomationFailure(diagnosisInput), hasMiniMaxCode("provider_authentication"));
  const metadata = warnings.find((entry) => entry[0] === "[MiniMax] diagnosis failed")?.[1] as Record<string, unknown> | undefined;
  assert.equal(metadata?.errorCode, "provider_authentication");
});

test("diagnoseAutomationFailure 将 provider 500 映射为 provider_error", async (t) => {
  const { service } = await createDiagnosisService(t, (response) => {
    response.statusCode = 500;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ error: { message: "raw-response-secret", type: "server_error" } }));
  });

  await assert.rejects(service.diagnoseAutomationFailure(diagnosisInput), hasMiniMaxCode("provider_error"));
});

test("diagnoseAutomationFailure 日志不泄漏原始请求、响应或 tool arguments", async (t) => {
  const seen: string[] = [];
  const originalInfo = console.info;
  const originalWarn = console.warn;
  const originalError = console.error;
  const capture = (...args: unknown[]) => { seen.push(args.map((value) => typeof value === "string" ? value : JSON.stringify(value)).join(" ")); };
  console.info = capture;
  console.warn = capture;
  console.error = capture;
  t.after(() => {
    console.info = originalInfo;
    console.warn = originalWarn;
    console.error = originalError;
  });
  const { service } = await createDiagnosisService(t, (response) => sendDiagnosis(response, {
    ...validDiagnosis,
    hint: "raw-tool-arguments-canary",
  }));
  const requestWithCanary = { ...diagnosisInput, error: "raw-request-canary" };

  await assert.rejects(service.diagnoseAutomationFailure(requestWithCanary), hasMiniMaxCode("invalid_model_output"));

  const joined = seen.join("\n");
  assert.equal(joined.includes("raw-request-canary"), false);
  assert.equal(joined.includes("raw-response-canary"), false);
  assert.equal(joined.includes("raw-tool-arguments-canary"), false);
  assert.equal(joined.includes("function.arguments"), false);
});
