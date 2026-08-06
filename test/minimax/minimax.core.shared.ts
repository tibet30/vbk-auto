import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { MiniMaxService, MiniMaxServiceError } from "../../src/main/minimax/minimax.js";
import { createServer, type ServerResponse } from "node:http";


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

export {
  test,
  assert,
  MiniMaxService,
  MiniMaxServiceError,
  type DiagnosisPayload,
  validDiagnosis,
  diagnosisInput,
  sendDiagnosis,
  createDiagnosisService,
  hasMiniMaxCode,
};
