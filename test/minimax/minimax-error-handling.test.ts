import { assert, test } from "./minimax.core.shared.js";

import {
  classifyMiniMaxError,
  extractMiniMaxFailureReason,
  isStructuredFormatFailure,
  toRetryHint,
  normalizeFailureMessage,
} from "../../src/main/minimax/minimax-error-handling.js";

test("MiniMax 结构化失败报文应被 classifyMiniMaxError 判定为 invalid_model_output", () => {
  const reason = "[2] [MiniMax] structured response rejected { length: 134, hasThinkingBlock: false, hasJsonFence: false, reason: 'Unexpected end of JSON input' }";

  const error = {
    code: "provider_error",
    payload: {
      message: reason,
    },
  };

  const extracted = extractMiniMaxFailureReason(error);
  assert.equal(extracted, reason);
  assert.equal(classifyMiniMaxError(error), "invalid_model_output");
  assert.equal(isStructuredFormatFailure(extracted), true);
});

test("normalizeFailureMessage 在 structured failure 下不拼接连接类提示", () => {
  const reason = "[2] [MiniMax] structured response rejected { length: 134, hasThinkingBlock: false, hasJsonFence: false, reason: 'Unexpected end of JSON input' }";

  assert.equal(
    normalizeFailureMessage("invalid_model_output", reason),
    "MiniMax 返回的数据格式无法用于产品方案，请重试。",
  );
  assert.equal(normalizeFailureMessage("invalid_model_output", `本轮结构化失败：${reason}`), "MiniMax 返回的数据格式无法用于产品方案，请重试。");
});

test("normalizeFailureMessage 去除结构化失败的尾随连接提示", () => {
  const reason = "[2] [MiniMax] structured response rejected { length: 134, hasThinkingBlock: false, hasJsonFence: false, reason: 'Unexpected end of JSON input' }；请检查连接或配置后重试。";

  assert.equal(
    normalizeFailureMessage("invalid_model_output", reason),
    "MiniMax 返回的数据格式无法用于产品方案，请重试。",
  );
  assert.equal(
    normalizeFailureMessage(
      "invalid_model_output",
      "MiniMax 返回的数据格式无法用于产品方案，请重试。请检查连接或配置后重试。",
    ),
    "MiniMax 返回的数据格式无法用于产品方案，请重试。",
  );
});

test("重试链路以实际归类结果生成用户可见文案时不添加连接提示", () => {
  const reason = "[2] [MiniMax] structured response rejected { length: 134, hasThinkingBlock: false, hasJsonFence: false, reason: 'Unexpected end of JSON input' }";
  const error = {
    code: "provider_error",
    payload: {
      message: reason,
    },
  };

  const errorCode = classifyMiniMaxError(error);
  const finalMessage = normalizeFailureMessage(errorCode, extractMiniMaxFailureReason(error));

  assert.equal(errorCode, "invalid_model_output");
  assert.equal(finalMessage, "MiniMax 返回的数据格式无法用于产品方案，请重试。");
});

test("normalizeFailureMessage 处理多种连接/配置尾注写法", () => {
  const reason = "[2] [MiniMax] structured response rejected { length: 134, hasJsonFence: true, reason: 'Unexpected end of JSON input' } ; 请先检查网络/配置后再试；";
  const reason2 = "[2] [MiniMax] structured response rejected { length: 134, hasThinkingBlock: true, hasJsonFence: true, reason: 'Unexpected token' }，请检查并确认 API 配置后尝试重新请求。";

  assert.equal(normalizeFailureMessage("invalid_model_output", reason), "MiniMax 返回的数据格式无法用于产品方案，请重试。");
  assert.equal(normalizeFailureMessage("invalid_model_output", reason2), "MiniMax 返回的数据格式无法用于产品方案，请重试。");
});

test("normalizeFailureMessage 在 invalid_model_output 且提示尾部为“请检查网络或配置后再尝试请求”时仍不追加后缀", () => {
  const reason = "[payload] structured response rejected { length: 134, hasThinkingBlock: false, hasJsonFence: false, reason: 'Unexpected token' }，请先检查 API 配置并确认网络稳定后再尝试请求。";
  assert.equal(normalizeFailureMessage("invalid_model_output", reason), "MiniMax 返回的数据格式无法用于产品方案，请重试。");
});

test("normalizeFailureMessage 在 invalid_model_output 且尾部包含英文重试提示时不追加连接提示", () => {
  const reason = "[payload] structured response rejected { length: 134, hasThinkingBlock: false, hasJsonFence: true, reason: 'Unexpected end of JSON input' } ; Please check the API configuration and retry request.";
  assert.equal(normalizeFailureMessage("invalid_model_output", reason), "MiniMax 返回的数据格式无法用于产品方案，请重试。");
});

test("toRetryHint 清理中文尾注后用于重试", () => {
  assert.equal(
    toRetryHint("[2] [MiniMax] structured response rejected { length: 134, hasThinkingBlock: false, hasJsonFence: false, reason: 'Unexpected end of JSON input' }，请先检查 MiniMax API 配置后再尝试请求。"),
    "[2] [MiniMax] structured response rejected { length: 134, hasThinkingBlock: false, hasJsonFence: false, reason: 'Unexpected end of JSON input' }",
  );
});

test("toRetryHint 清理英文尾注后用于重试", () => {
  assert.equal(
    toRetryHint("structured response rejected { length: 134, hasJsonFence: true, reason: 'Unexpected end of JSON input' }. Please check API 配置并 retry request."),
    "structured response rejected { length: 134, hasJsonFence: true, reason: 'Unexpected end of JSON input' }.",
  );
});

test("normalizeFailureMessage 在 invalid_model_output 且包含中文+英文混排尾注且无明显中文连词时不追加连接提示", () => {
  const reason = "[MiniMax] structured response rejected { length: 134, hasThinkingBlock: true, reason: 'Unexpected token' } 请检查 API 配置后 attempt again。";
  assert.equal(normalizeFailureMessage("invalid_model_output", reason), "MiniMax 返回的数据格式无法用于产品方案，请重试。");
});

test("extractMiniMaxFailureReason 可读取 MiniMaxServiceError.details 字段", () => {
  const reason = "[2] [MiniMax] structured response rejected { length: 134, hasThinkingBlock: false, hasJsonFence: false, reason: 'Unexpected end of JSON input' }";
  const extracted = extractMiniMaxFailureReason({
    code: "invalid_model_output",
    message: "MiniMax 返回的数据格式无法用于产品方案，请重试。",
    details: reason,
  });
  assert.equal(extracted, reason);
});
