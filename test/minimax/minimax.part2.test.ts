import { test, assert, MiniMaxService, MiniMaxServiceError, diagnosisInput, hasMiniMaxCode, sendDiagnosis, createDiagnosisService, validDiagnosis } from "./minimax.core.shared.js";

test("下拉 AI 消歧使用独立短超时，不沿用规划对话 90 秒超时", async () => {
  const source = await import("node:fs/promises").then((fs) => fs.readFile(
    new URL("../../src/main/minimax/minimax-service.ts", import.meta.url),
    "utf8",
  ));
  assert.match(source, /function disambiguationTimeout\(\)/);
  assert.match(source, /return Number\.isFinite\(parsed\)[\s\S]*?8_000/);
  const start = source.indexOf("async disambiguateOption");
  const body = source.slice(start, source.indexOf("\n  /**", start + 10));
  assert.match(body, /this\.client\(disambiguationTimeout\(\)\)/);
  assert.doesNotMatch(body, /this\.client\(replyTimeout\(\)\)/);
});
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
  assert.match(prompt, /reload_and_retry_phase.*找不到可设置\/可填写\/可点击项/s);
  assert.match(prompt, /itinerary.*首日集合时间.*优先选择 reload_and_retry_phase/s);
});

test("diagnoseAutomationFailure 提示首日集合时间首轮控件缺失优先刷新重试", async (t) => {
  const { service, requestBody } = await createDiagnosisService(t, (response) => sendDiagnosis(response, {
    summary: "首日集合时间控件可能未渲染。",
    rootCause: "产品和前置阶段已有保存证据，首轮只看到控件缺失。",
    action: "reload_and_retry_phase",
    expectedEvidence: "刷新重试后首日集合时间被成功设置。",
  }));

  await service.diagnoseAutomationFailure({
    phase: "itinerary",
    attempt: 1,
    error: "找不到可设置的首日集合时间",
    productIdExists: true,
    basicInfoSaved: true,
    completedPhases: ["basic", "presentation"],
    diagnosisHistory: [],
  });

  const body = JSON.parse(requestBody()) as { messages: Array<{ role: string; content: string }> };
  const joined = body.messages.map((message) => message.content).join("\n");
  assert.match(joined, /找不到可设置的首日集合时间/);
  assert.match(joined, /前置阶段已完成.*优先选择 reload_and_retry_phase/s);
  assert.doesNotMatch(joined, /信息不足时返回 wait_for_user/);
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
  const metadata = warnings.find((entry) => typeof entry[0] === "string" && entry[0].includes("[AI] diagnosis failed"))?.[1] as Record<string, unknown> | undefined;
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

  // 只检查状态日志（[AI] / [MiniMax] / 错误码等）是否泄漏；
  // [AI prompt] 日志按设计是会包含实际发送的 messages，所以排除前缀匹配的行。
  const statusJoined = seen.filter((line) => !line.includes("[AI prompt]")).join("\n");
  assert.equal(statusJoined.includes("raw-request-canary"), false);
  assert.equal(statusJoined.includes("raw-response-canary"), false);
  assert.equal(statusJoined.includes("raw-tool-arguments-canary"), false);
  assert.equal(statusJoined.includes("function.arguments"), false);

  // 反向验证：[AI prompt] 日志确实存在（说明新功能生效），但不允许出现伪造的敏感凭据字面量。
  const promptJoined = seen.filter((line) => line.includes("[AI prompt]")).join("\n");
  assert.match(promptJoined, /\[AI prompt\]/);
  assert.equal(/api[_-]?key\s*[:=]\s*["']?[A-Za-z0-9_\-]{6,}/i.test(promptJoined), false, "[AI prompt] 不应含 apiKey 字面量");
  assert.equal(/Bearer\s+[A-Za-z0-9_\-\.=]{8,}/i.test(promptJoined), false, "[AI prompt] 不应含 Bearer 令牌字面量");
  assert.equal(/Cookie\s*:\s*[A-Za-z0-9_\-]+\s*=/i.test(promptJoined), false, "[AI prompt] 不应含 Cookie 头字面量");
});
