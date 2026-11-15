import { AiSdkAgentModel } from "./ai-sdk-model.js";
import { OpenAIAgentModel } from "./openai-model.js";
import type { AgentModel } from "./types.js";

export interface AgentModelTransportConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs?: number;
  /** Provider-specific request body fields (MiniMax thinking / service_tier). */
  extraParams?: Record<string, unknown>;
  onUsage?: (usage: { inputTokens?: number; outputTokens?: number; cachedTokens?: number }) => void;
  onLog?: (entry: { model: string; toolNames: string[]; inputTokens?: number; outputTokens?: number }) => void;
}

/**
 * Agent 传输层工厂。
 *
 * 默认走 AI SDK（`AiSdkAgentModel`）：单步 `streamText`，工具循环仍由 AgentCore 驱动。
 * `VBK_AGENT_TRANSPORT=legacy` 可整层切回 OpenAI SDK 实现，用于线上问题定位或回退，
 * 不需要改调用方；两套实现共用同一个 `AgentModel` 契约。
 */
export function createAgentModel(config: AgentModelTransportConfig): AgentModel {
  if (process.env.VBK_AGENT_TRANSPORT === "legacy") return new OpenAIAgentModel(config);
  return new AiSdkAgentModel(config);
}
