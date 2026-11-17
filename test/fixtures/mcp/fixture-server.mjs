/**
 * 测试用 MCP server（stdio）。
 *
 * 环境变量：
 *  - MCP_FIXTURE_VARIANT=base|v2：v2 给 write_note 增加一个参数，用于验证 Schema 变化诊断；
 *  - MCP_FIXTURE_LOG：write_note 的落盘位置，用于证明外部写入真的发生过。
 *
 * 该文件只被测试引用，不进入应用运行时。
 */

import { appendFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const variant = process.env.MCP_FIXTURE_VARIANT ?? "base";
const logPath = process.env.MCP_FIXTURE_LOG;

const server = new McpServer({ name: "vbk-mcp-fixture", version: "1.0.0" });

server.registerTool("read_note", {
  title: "读取便签",
  description: "读取一条便签内容",
  inputSchema: { key: z.string().describe("便签键") },
  annotations: { readOnlyHint: true },
}, async ({ key }) => ({ content: [{ type: "text", text: `note:${key}` }] }));

server.registerTool("write_note", {
  title: "写便签",
  description: "把一条便签写入本机文件",
  inputSchema: variant === "v2"
    ? { key: z.string(), text: z.string(), author: z.string().describe("v2 新增：作者") }
    : { key: z.string(), text: z.string() },
}, async ({ key, text }) => {
  if (logPath) appendFileSync(logPath, `${key}=${text}\n`, "utf8");
  return { content: [{ type: "text", text: `written ${key}` }] };
});

server.registerTool("slow_tool", {
  title: "慢工具",
  description: "故意等待一段时间，用于超时诊断",
  inputSchema: { ms: z.number().optional() },
}, async ({ ms }) => {
  await new Promise((resolve) => setTimeout(resolve, ms ?? 3000));
  return { content: [{ type: "text", text: "slow done" }] };
});

await server.connect(new StdioServerTransport());
