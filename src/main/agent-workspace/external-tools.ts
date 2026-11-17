/**
 * 外部 MCP 工具的运行期容器：读配置、发现工具、缓存诊断。
 *
 * 与 `AgentRuntime` 的分工：本模块只管"外部有哪些工具可用、状态如何"，
 * 发现出来的 Skill 交给运行时，审批与收据仍走 `PermissionPolicy` / `ActionExecutor`。
 */

import type {
  AgentExternalToolStatus,
  AgentExternalToolsSnapshot,
  AgentMcpServerInput,
} from "../../shared/contracts-agent-runtime.js";
import type { VbkDatabase } from "../infrastructure/database/database.js";
import { createMcpSkillSource, type McpSkillSource } from "../agent-runtime/mcp/source.js";
import { parseMcpServers, validateMcpServersInput } from "../agent-runtime/mcp/config.js";
import type { AgentSkill } from "../agent-runtime/types.js";
import type { McpServerConfig } from "../agent-runtime/mcp/client.js";

export const MCP_SERVERS_SETTING_KEY = "agentMcpServers";

export class ExternalToolRuntime {
  private source: McpSkillSource | undefined;
  private sourceKey = "";
  private skills: AgentSkill[] = [];
  private status: AgentExternalToolStatus[] = [];
  private skipped: string[] = [];
  private config: McpServerConfig[] = [];

  constructor(
    private readonly db: VbkDatabase,
    private readonly createSource: typeof createMcpSkillSource = createMcpSkillSource,
  ) {}

  /** 诊断用：配置里被跳过的条目原因。 */
  skippedEntries(): readonly string[] {
    return this.skipped;
  }

  currentSkills(): AgentSkill[] {
    return this.skills;
  }

  currentStatus(): AgentExternalToolStatus[] {
    return this.status;
  }

  /** 面向设置页的快照：配置（不含 env）+ 连接状态 + 被跳过的条目。 */
  snapshot(): AgentExternalToolsSnapshot {
    return {
      servers: this.config.map((server) => ({
        id: server.id,
        command: server.command,
        args: [...(server.args ?? [])],
        ...(server.label ? { label: server.label } : {}),
        ...(server.timeoutMs ? { timeoutMs: server.timeoutMs } : {}),
      })),
      status: this.status,
      skipped: [...this.skipped],
    };
  }

  /**
   * 保存设置页提交的配置。界面不编辑 env，但**不能顺手丢掉**代码配置里的 env，
   * 因此按 id 合并既有值后再落库。
   */
  async save(servers: readonly AgentMcpServerInput[]): Promise<AgentExternalToolsSnapshot> {
    const validated = validateMcpServersInput(servers as unknown as readonly Record<string, unknown>[]);
    if (validated.error !== undefined) throw new Error(validated.error);
    const existing = new Map(this.config.map((server) => [server.id, server]));
    const next = validated.servers.map((server) => ({
      ...server,
      env: existing.get(server.id)?.env ?? {},
    }));
    this.db.setSetting(MCP_SERVERS_SETTING_KEY, JSON.stringify(next));
    await this.refresh({ force: true });
    return this.snapshot();
  }

  /**
   * 重新读配置并发现工具。配置为空时会关闭已有连接；配置变化会重建来源。
   * 发现失败只记状态，不抛错——外部服务不可用不能挡住内置 Skill。
   */
  async refresh(options: { force?: boolean } = {}): Promise<{ skills: AgentSkill[]; status: AgentExternalToolStatus[] }> {
    const raw = this.db.getSetting(MCP_SERVERS_SETTING_KEY)?.value;
    const parsed = parseMcpServers(raw);
    this.skipped = parsed.skipped;
    if (!parsed.servers.length) {
      await this.source?.closeAll();
      this.source = undefined;
      this.sourceKey = "";
      this.skills = [];
      this.config = [];
      this.status = this.skipped.length
        ? parsed.skipped.map((reason, index) => ({
          serverId: `skipped-${index + 1}`,
          label: "配置已跳过",
          state: "failed" as const,
          tools: [],
          changes: [],
          error: reason,
        }))
        : [];
      return { skills: this.skills, status: this.status };
    }

    this.config = [...parsed.servers];
    const key = JSON.stringify(parsed.servers);
    if (!this.source || key !== this.sourceKey) {
      await this.source?.closeAll();
      this.source = this.createSource({ servers: parsed.servers });
      this.sourceKey = key;
    }
    // force 用于显式重连（server 升级后比对 Schema 变化），常规刷新走 TTL 缓存。
    const result = await this.source.discover({ force: options.force === true });
    this.skills = result.skills;
    this.status = result.diagnostics.map((entry) => ({
      serverId: entry.serverId,
      label: entry.label,
      state: entry.state,
      tools: entry.tools,
      changes: entry.changes,
      ...(entry.error ? { error: entry.error } : {}),
    }));
    return { skills: this.skills, status: this.status };
  }

  /** 断开或重连单个服务；配置不动，只影响连接与工具暴露。 */
  async setConnection(serverId: string, connected: boolean): Promise<AgentExternalToolsSnapshot> {
    if (!this.config.some((server) => server.id === serverId)) {
      throw new Error(`没有这个外部服务：${serverId}`);
    }
    await this.refresh();
    if (!this.source) throw new Error("外部工具尚未初始化，请先刷新。");
    await this.source.setEnabled(serverId, connected);
    await this.refresh({ force: connected });
    return this.snapshot();
  }

  async close(): Promise<void> {
    await this.source?.closeAll();
    this.source = undefined;
    this.sourceKey = "";
    this.skills = [];
    this.status = [];
  }
}
