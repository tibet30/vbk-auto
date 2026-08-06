import { test, assert, MiniMaxService, MiniMaxServiceError, diagnosisInput, hasMiniMaxCode, sendDiagnosis, createDiagnosisService, validDiagnosis } from "./minimax.core.shared.js";
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
