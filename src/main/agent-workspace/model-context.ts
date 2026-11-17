/**
 * 通用智能体的模型上下文：系统提示、Skill 说明与 provider 装配。
 *
 * 抽成独立模块的原因：系统提示属于"模型能看到什么"这一层，和线程/运行/审批的
 * 编排逻辑无关；放在一起会让对话服务不断膨胀并挤占行数上限。
 */

import { aiProviderConfig } from "../../shared/ai-provider-config.js";
import type { AgentSkillSummary } from "../../shared/contracts-agent-runtime.js";
import type { AgentThreadSummary } from "../../shared/contracts-agent-workspace.js";
import type { MainIpcContext } from "../ipc/context.js";
import { createAgentModel } from "../agent/agent-model-factory.js";
import { planningTransportOptions } from "../planning/adapters/openai-compatible-transport.js";

const SYSTEM_INSTRUCTIONS = `你是三人同游智能体，帮助运营完成通用办公任务。
你可以调用已安装 Skill 的工具：读取类动作会直接执行并留下审计收据；写入、删除类动作必须先由运营授权，批准前不会发生任何外部写入。
每一轮只提出一个工具调用；需要多个动作时请逐个提出，拿到结果后再提下一个。
不得声称已经操作后台、读取文件或创建产物，除非工具结果或收据明确证明完成。没有收据时如实说明"尚未执行"。
产品业务的程序检查、运营确认与行程录入只能由运营在产品界面完成；产品查询类 Skill 只读，不能替代任何一道门禁，也不得替运营宣布"已确认"或"已录入"。
回答使用简体中文，先给结论，再给必要步骤。`;


export interface AgentModelProviderResult {
  model: ReturnType<typeof createAgentModel>;
  systemPrompt: string;
}

function toolGuidance(skills: readonly AgentSkillSummary[]): string {
  if (!skills.length) return "";
  return `可用 Skill：\n${skills.map((skill) => `- ${skill.label}（${skill.id}）：${skill.description}\n  动作：${skill.actions.map((action) => `${action.name}（${action.label}，${action.kind}）`).join("、")}`).join("\n")}`;
}

/** 每次运行前装配一次：模型连接 + 系统提示（含摘要、记忆、Skill 清单）。 */
export async function createModelProvider(input: {
  context: MainIpcContext;
  summary?: AgentThreadSummary;
  skills: readonly AgentSkillSummary[];
}): Promise<AgentModelProviderResult> {
  const settings = input.context.getSettings();
  const profile = aiProviderConfig(settings, settings.aiProvider);
  const key = await input.context.apiKey(settings.aiProvider);
  if (!key) throw new Error("请先在设置中配置当前 AI 服务的密钥。");
  const model = createAgentModel({
    apiKey: key,
    baseUrl: profile.baseUrl,
    model: profile.model,
    extraParams: planningTransportOptions(settings.aiProvider).extraParams,
  });
  let memories: string[] = [];
  try {
    memories = input.context.memoryService?.loadContextMemories().lines ?? [];
  } catch {
    memories = [];
  }
  const systemPrompt = [
    SYSTEM_INSTRUCTIONS,
    toolGuidance(input.skills),
    input.summary?.text ? `较早对话摘要：\n${input.summary.text}` : "",
    memories.length ? `已确认的用户记忆：\n${memories.join("\n")}` : "",
  ].filter(Boolean).join("\n\n");
  return { model, systemPrompt };
}
