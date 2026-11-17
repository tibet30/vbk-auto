/**
 * 把 MCP server 的工具桥接成内置格式的 Skill 动作。
 *
 * 三条硬约束：
 *  - server 只声明 `readOnlyHint` 的工具才算只读，其余一律按写入处理，
 *    必须走审批与收据；MCP 的能力声明不能直接授予写权限；
 *  - 同一 server 的写动作共用一个账号键，天然串行；
 *  - 调用超时属于"可能已经执行"，一律抛 `AgentUncertainActionError`，
 *    由执行器落成 uncertain，禁止盲目重试。
 */

import type { AgentActionRisk } from "../../../shared/contracts-agent-runtime.js";
import type { AgentSkill, AgentSkillAction } from "../types.js";
import { AgentUncertainActionError } from "../types.js";
import { McpTimeoutError, type McpServerConfig, type McpToolDescriptor } from "./client.js";

export interface McpToolBridge {
  serverId: string;
  serverLabel: string;
  callTool(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
}

const ARG_PREVIEW_LIMIT = 600;

function actionName(serverId: string, toolName: string): string {
  return `mcp.${serverId}.${toolName}`;
}

function riskOf(tool: McpToolDescriptor): AgentActionRisk {
  if (tool.readOnly) return "low";
  return tool.destructive ? "high" : "medium";
}

function previewOf(tool: McpToolDescriptor, args: Record<string, unknown>): string {
  const serialized = JSON.stringify(args ?? {});
  const body = serialized.length > ARG_PREVIEW_LIMIT ? `${serialized.slice(0, ARG_PREVIEW_LIMIT)}…` : serialized;
  return `参数：${body}`;
}

export function createMcpActions(bridge: McpToolBridge, tools: McpToolDescriptor[]): AgentSkillAction[] {
  return tools.map((tool) => {
    const name = actionName(bridge.serverId, tool.name);
    const action: AgentSkillAction = {
      name,
      kind: tool.readOnly ? "read" : "write",
      label: tool.description.trim() || tool.name,
      risk: riskOf(tool),
      description: `${tool.description || tool.name}（外部 MCP 工具，服务：${bridge.serverLabel}）`,
      parameters: tool.inputSchema,
      async target() {
        return {
          action: name,
          targetKey: `mcp:${bridge.serverId}:${tool.name}`,
          accountKey: `mcp:${bridge.serverId}`,
          risk: riskOf(tool),
        };
      },
      async preview(args) {
        return {
          summary: `调用 ${bridge.serverLabel}.${tool.name}${tool.readOnly ? "（只读）" : "（写入）"}`,
          diff: previewOf(tool, args),
        };
      },
      async execute(args) {
        let result: { text: string; isError: boolean };
        try {
          result = await bridge.callTool(tool.name, args);
        } catch (error) {
          if (error instanceof McpTimeoutError) {
            throw new AgentUncertainActionError(
              `MCP ${bridge.serverLabel}.${tool.name} 调用超时，外部是否已执行未知；请先核查再重试。`,
            );
          }
          throw error;
        }
        if (result.isError) throw new Error(result.text || `${tool.name} 调用失败`);
        return {
          content: result.text,
          summary: `调用 ${bridge.serverLabel}.${tool.name} 成功`,
          result: result.text.slice(0, 500),
        };
      },
    };
    return action;
  });
}

export function createMcpSkill(config: McpServerConfig, bridge: McpToolBridge, tools: McpToolDescriptor[]): AgentSkill {
  return {
    id: `mcp-${config.id}`,
    label: config.label ?? config.id,
    description: `外部 MCP 工具（${config.label ?? config.id}）：${tools.map((tool) => tool.name).join("、")}`,
    actions: createMcpActions(bridge, tools),
  };
}
