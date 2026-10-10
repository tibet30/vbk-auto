/**
 * OpenAI function-calling 工具定义集合：
 *   - responseTool：主回复工具（submit_product_update），结构 = responseJsonSchema；
 *   - diagnosisTool：失败诊断工具（submit_failure_diagnosis），受白名单 action 约束；
 *   - disambiguateTool：VBK 下拉候选项消歧（submit_disambiguation）；
 *   - subtitleTool：单字段副标题重新生成（submit_subtitle）。
 *
 * 注意：这些只是 SDK 用的 schema/descriptor，本身不发起网络请求。
 */

import { APP_NAME } from "../../../shared/brand.js";
import { responseJsonSchema } from "./writable-paths.js";

export const responseTool = {
  type: "function",
  function: {
    name: "submit_product_update",
    description: `返回给 ${APP_NAME} 的产品协作回复、JSON Patch 和核查任务。`,
    strict: true,
    parameters: responseJsonSchema,
  },
};

const advisorActions = [
  "retry_same_phase",
  "reload_and_retry_phase",
  "reopen_editor_and_retry_phase",
  "wait_for_user",
] as const;

export const diagnosisTool = {
  type: "function",
  function: {
    name: "submit_failure_diagnosis",
    description: "返回自动录入阶段失败的结构化诊断。",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["summary", "rootCause", "action", "expectedEvidence"],
      properties: {
        summary: { type: "string", minLength: 1, maxLength: 80 },
        rootCause: { type: "string", minLength: 1, maxLength: 200 },
        action: { type: "string", enum: advisorActions },
        expectedEvidence: { type: "string", minLength: 1, maxLength: 120 },
        userInstruction: { type: "string", minLength: 1, maxLength: 500 },
      },
    },
  },
};

export const disambiguateTool = {
  type: "function",
  function: {
    name: "submit_disambiguation",
    description: "从候选项中选一个与 desired 最接近的。无合适选择返回空串，并给出 0 到 1 的置信度。",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["pickedText", "confidence", "reasoning"],
      properties: {
        pickedText: { type: "string" },
        confidence: { type: "number", minimum: 0, maximum: 1 },
        reasoning: { type: "string", minLength: 1, maxLength: 200 },
      },
    },
  },
};

/**
 * AI 副标题单字段重新生成：专用 function-calling 工具。
 * 只返回一个 2~80 字的中文副标题，便于 renderer 展示候选、由用户确认后再落库。
 */
export const subtitleTool = {
  type: "function",
  function: {
    name: "submit_subtitle",
    description: "为旅游产品提交一个简洁、面向游客的中文副标题（2~80 字）。",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["subtitle"],
      properties: {
        subtitle: { type: "string", minLength: 2, maxLength: 80 },
      },
    },
  },
};
