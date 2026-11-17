/**
 * 设置页面对外部 MCP 工具的入口。
 *
 * 与对话链路共用同一个 `ExternalToolRuntime`（同一批子进程），
 * 配置变化后通过 `onChanged` 让对话服务重建运行时，避免两套连接并存。
 */

import type { AgentExternalToolsSnapshot, AgentMcpServerInput } from "../../shared/contracts-agent-runtime.js";
import type { ExternalToolRuntime } from "./external-tools.js";

export class ExternalToolSettings {
  constructor(
    private readonly runtime: ExternalToolRuntime,
    private readonly onChanged: () => void,
  ) {}

  /** 按 TTL 复用已有连接，只读取当前配置与状态。 */
  async read(): Promise<AgentExternalToolsSnapshot> {
    await this.runtime.refresh();
    return this.runtime.snapshot();
  }

  /** 保存配置并立即重连；校验失败直接抛错，不落库。 */
  async save(servers: AgentMcpServerInput[]): Promise<AgentExternalToolsSnapshot> {
    const snapshot = await this.runtime.save(servers);
    this.onChanged();
    return snapshot;
  }

  /** 断开或重连单个服务；断开后该服务的工具不再暴露给模型。 */
  async setConnection(serverId: string, connected: boolean): Promise<AgentExternalToolsSnapshot> {
    const snapshot = await this.runtime.setConnection(serverId, connected);
    this.onChanged();
    return snapshot;
  }

  /** 显式重连，用于 server 升级后比对工具 Schema 变化。 */
  async refresh(): Promise<AgentExternalToolsSnapshot> {
    await this.runtime.refresh({ force: true });
    this.onChanged();
    return this.runtime.snapshot();
  }
}
