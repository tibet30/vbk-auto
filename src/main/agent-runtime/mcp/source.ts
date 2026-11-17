/**
 * MCP Skill 来源：发现、缓存、诊断。
 *
 * 设计取舍：
 *  - 单个 server 连接失败不能拖垮智能体：失败只记诊断，其余 Skill 照常可用；
 *  - 工具 Schema 变化按 server 记忆指纹，重连后可比对出"新增 / 移除 / 参数变化"；
 *  - 默认 60 秒缓存，避免每次发消息都重连外部进程；`force` 用于显式刷新。
 */

import type { AgentSkill } from "../types.js";
import {
  McpServerConnection,
  toolFingerprint,
  type McpConnectionState,
  type McpServerConfig,
  type McpToolDescriptor,
} from "./client.js";
import { createMcpSkill } from "./skill.js";

export interface McpDiscoveryDiagnostic {
  serverId: string;
  label: string;
  state: McpConnectionState;
  tools: string[];
  /** Schema 变化说明；空数组表示与上次一致。 */
  changes: string[];
  error?: string;
}

export interface McpDiscoveryResult {
  skills: AgentSkill[];
  diagnostics: McpDiscoveryDiagnostic[];
}

export interface McpSkillSource {
  discover(options?: { force?: boolean }): Promise<McpDiscoveryResult>;
  diagnostics(): readonly McpDiscoveryDiagnostic[];
  /** 运营手动断开/重连单个服务；不影响其他服务。 */
  setEnabled(serverId: string, enabled: boolean): Promise<void>;
  closeAll(): Promise<void>;
}

const DEFAULT_TTL_MS = 60_000;

export function createMcpSkillSource(options: {
  servers: readonly McpServerConfig[];
  ttlMs?: number;
  now?: () => number;
}): McpSkillSource {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const now = options.now ?? (() => Date.now());
  const connections = new Map<string, McpServerConnection>();
  const fingerprints = new Map<string, Map<string, string>>();
  let cached: McpDiscoveryResult | undefined;
  let cachedAt = 0;
  /** 运营手动断开的服务：配置保留，但不再连接、工具也不再暴露。 */
  const disabled = new Set<string>();

  function changesFor(serverId: string, tools: McpToolDescriptor[]): string[] {
    const previous = fingerprints.get(serverId);
    const next = new Map(tools.map((tool) => [tool.name, toolFingerprint(tool)]));
    fingerprints.set(serverId, next);
    if (!previous) return [];
    const changes: string[] = [];
    for (const [name, fingerprint] of next) {
      const before = previous.get(name);
      if (!before) changes.push(`新增工具 ${name}`);
      else if (before !== fingerprint) changes.push(`工具 ${name} 的输入 Schema 发生变化`);
    }
    for (const name of previous.keys()) {
      if (!next.has(name)) changes.push(`移除工具 ${name}`);
    }
    return changes;
  }

  async function discoverServer(config: McpServerConfig, force: boolean): Promise<{
    skill?: AgentSkill;
    diagnostic: McpDiscoveryDiagnostic;
  }> {
    if (disabled.has(config.id)) {
      return {
        diagnostic: {
          serverId: config.id,
          label: config.label ?? config.id,
          state: "closed",
          tools: [],
          changes: [],
        },
      };
    }
    let connection = connections.get(config.id);
    try {
      if (connection && force) {
        await connection.close();
        connections.delete(config.id);
        connection = undefined;
      }
      if (!connection) {
        connection = new McpServerConnection(config);
        connections.set(config.id, connection);
      }
      await connection.connect();
      const tools = await connection.listTools();
      const summary = connection.diagnostics();
      const skill = createMcpSkill(config, {
        serverId: config.id,
        serverLabel: connection.label,
        callTool: (name, args) => connection!.callTool(name, args),
      }, tools);
      return {
        skill,
        diagnostic: {
          serverId: config.id,
          label: connection.label,
          state: summary.state,
          tools: tools.map((tool) => tool.name),
          changes: changesFor(config.id, tools),
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        diagnostic: {
          serverId: config.id,
          label: config.label ?? config.id,
          state: "failed",
          tools: [],
          changes: [],
          error: message,
        },
      };
    }
  }

  async function discover(discoverOptions: { force?: boolean } = {}): Promise<McpDiscoveryResult> {
    const force = discoverOptions.force === true;
    if (!force && cached && now() - cachedAt < ttlMs) return cached;
    const skills: AgentSkill[] = [];
    const diagnostics: McpDiscoveryDiagnostic[] = [];
    for (const config of options.servers) {
      const { skill, diagnostic } = await discoverServer(config, force);
      diagnostics.push(diagnostic);
      if (skill) skills.push(skill);
    }
    cached = { skills, diagnostics };
    cachedAt = now();
    return cached;
  }

  return {
    discover,
    diagnostics: () => cached?.diagnostics ?? [],
    async setEnabled(serverId: string, enabled: boolean) {
      if (!options.servers.some((server) => server.id === serverId)) {
        throw new Error(`没有这个外部服务：${serverId}`);
      }
      if (enabled) {
        disabled.delete(serverId);
      } else {
        disabled.add(serverId);
        const connection = connections.get(serverId);
        connections.delete(serverId);
        await connection?.close().catch(() => undefined);
      }
      // 缓存必须失效，否则下一次读取还会拿到旧的工具清单。
      cached = undefined;
      cachedAt = 0;
    },
    async closeAll() {
      for (const connection of connections.values()) {
        await connection.close().catch(() => undefined);
      }
      connections.clear();
      cached = undefined;
      cachedAt = 0;
    },
  };
}
