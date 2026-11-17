/**
 * MCP stdio 连接：连接、列工具、调用工具、诊断。
 *
 * 只做协议与超时，不做权限判定：MCP server 声明的能力**不构成**写权限，
 * 是否放行由 `PermissionPolicy` + `ActionExecutor` 决定（见 `mcp/skill.ts`）。
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export interface McpServerConfig {
  /** 用户可见标识，参与账号键与目标键，必须唯一且稳定。 */
  id: string;
  label?: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** 单次连接 / 调用的超时，默认见下方常量。 */
  timeoutMs?: number;
}

export type McpConnectionState = "idle" | "connecting" | "ready" | "failed" | "closed";

export interface McpToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** 只有 server 显式声明 readOnlyHint 才算只读；其余一律按写入处理。 */
  readOnly: boolean;
  destructive: boolean;
}

export interface McpConnectionDiagnostics {
  state: McpConnectionState;
  lastError?: string;
  tools: string[];
}

const CONNECT_TIMEOUT_MS = 15_000;
const CALL_TIMEOUT_MS = 20_000;

export class McpTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpTimeoutError";
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new McpTimeoutError(`${label}超时（${timeoutMs}ms）`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class McpServerConnection {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private currentState: McpConnectionState = "idle";
  private lastError: string | undefined;
  private tools: McpToolDescriptor[] = [];

  constructor(private readonly config: McpServerConfig) {}

  get id(): string {
    return this.config.id;
  }

  get label(): string {
    return this.config.label ?? this.config.id;
  }

  get timeoutMs(): number {
    return this.config.timeoutMs ?? CALL_TIMEOUT_MS;
  }

  diagnostics(): McpConnectionDiagnostics {
    return {
      state: this.currentState,
      ...(this.lastError ? { lastError: this.lastError } : {}),
      tools: this.tools.map((tool) => tool.name),
    };
  }

  async connect(): Promise<void> {
    if (this.currentState === "ready" && this.client) return;
    this.currentState = "connecting";
    this.lastError = undefined;
    try {
      const transport = new StdioClientTransport({
        command: this.config.command,
        args: this.config.args ?? [],
        // 本地 stdio server 与主进程同用户运行，沿用当前环境变量并叠加配置项。
        env: { ...(process.env as Record<string, string>), ...(this.config.env ?? {}) },
        stderr: "pipe",
      });
      const client = new Client({ name: "sanrentongyou-agent", version: "1.0.0" }, { capabilities: {} });
      await withTimeout(client.connect(transport), this.config.timeoutMs ?? CONNECT_TIMEOUT_MS, `连接 ${this.label} `);
      this.client = client;
      this.transport = transport;
      this.currentState = "ready";
    } catch (error) {
      this.currentState = "failed";
      this.lastError = error instanceof Error ? error.message : String(error);
      await this.close().catch(() => undefined);
      throw error;
    }
  }

  async listTools(): Promise<McpToolDescriptor[]> {
    const client = this.requireClient();
    const result = await withTimeout(client.listTools(), this.timeoutMs, `列出 ${this.label} 的工具`);
    this.tools = (result.tools ?? []).map(toDescriptor);
    return this.tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
    const client = this.requireClient();
    const result = await withTimeout(
      client.callTool({ name, arguments: args }),
      this.timeoutMs,
      `调用 ${this.label}.${name} `,
    );
    return {
      text: flattenContent(result.content),
      isError: result.isError === true,
    };
  }

  async close(): Promise<void> {
    const client = this.client;
    const transport = this.transport;
    this.client = null;
    this.transport = null;
    this.tools = [];
    if (this.currentState !== "failed") this.currentState = "closed";
    try {
      if (client) await client.close();
    } finally {
      if (transport) await transport.close().catch(() => undefined);
    }
  }

  private requireClient(): Client {
    if (!this.client || this.currentState !== "ready") {
      throw new Error(`MCP server ${this.label} 尚未连接，请先连接后再调用。`);
    }
    return this.client;
  }
}

function toDescriptor(tool: {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
}): McpToolDescriptor {
  return {
    name: tool.name,
    description: tool.description ?? "",
    inputSchema: tool.inputSchema,
    readOnly: tool.annotations?.readOnlyHint === true,
    destructive: tool.annotations?.destructiveHint === true,
  };
}

/** MCP 的 content 是数组，只把文本部分拼给模型；其他类型如实标注而不是丢掉。 */
function flattenContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content.map((item) => {
    const block = item as { type?: string; text?: string; mimeType?: string };
    if (block.type === "text" && typeof block.text === "string") return block.text;
    if (block.type === "image") return `[图片 ${block.mimeType ?? ""}]`;
    if (block.type === "resource") return "[资源]";
    return `[${block.type ?? "未知内容"}]`;
  }).join("\n");
}

/** 稳定指纹：用于发现 server 升级导致的工具 Schema 变化。 */
export function toolFingerprint(tool: McpToolDescriptor): string {
  const schema = JSON.stringify(tool.inputSchema ?? {}, Object.keys(tool.inputSchema ?? {}).sort());
  return `${tool.name}|${tool.readOnly ? "r" : "w"}|${schema}`;
}
