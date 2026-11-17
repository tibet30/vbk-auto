# 通用智能体工作台 SDK 选型评估

日期：2026-11-16

## 结论

可以大量复用成熟 SDK，但不建议用新的“全家桶 Agent 框架”替换当前产品 Agent。

推荐组合：

1. 继续使用仓库现有 `ai` v7 与 `@ai-sdk/openai-compatible`，承担模型接入、流式输出、工具 Schema 与工具调用协议。
2. 继续使用现有 Playwright，承担 VBK 和三人同游后台的浏览器读取与操作。
3. 内置核心能力继续定义为进程内 AI SDK tools；为未来用户安装的外部 Skill 增加官方 MCP TypeScript client。
4. 使用 PptxGenJS 生成可编辑 `.pptx`。
5. 继续用项目现有 `better-sqlite3` 保存任务、授权、运行和操作收据。
6. 权限范围、后台写入串行化、产品版本门禁、不确定写入恢复和幂等收据必须由项目自己的薄业务层负责。

不建议首期引入 LangGraph 或 Mastra。两者能力成熟，但会与现有 AgentCore、SQLite 状态和 AI SDK 传输栈形成第二套编排与持久化体系。LangGraph 可保留为后续技术验证候选，不作为第一阶段前置依赖。

## 当前仓库已经具备的基础

- `package.json` 已包含 `ai` v7、`@ai-sdk/openai-compatible`、`playwright`、`better-sqlite3`、`zod`。
- `src/main/agent/ai-sdk-model.ts` 已通过 `createOpenAICompatible()` 接入 MiniMax，并用单步 `streamText()` 返回文本和工具调用。
- 当前设计明确让 `AgentCore` 掌握工具循环、产品门禁、审批、事件流和恢复，AI SDK 只负责模型传输。
- 当前 Playwright 层已经有登录账号、BrowserView、后台请求、独占执行、页面恢复和大量生产定位逻辑。

这意味着最重要的“通用模型协议”和“真实后台执行”并不需要重造。

## 逐项评估

### 1. Vercel AI SDK：采用，继续作为核心模型与工具层

官方 `ToolLoopAgent` 能自动进行多步模型—工具循环，并在没有工具调用、遇到需要审批的工具或达到停止条件时停止。AI SDK tools 支持 Zod/JSON Schema、动态工具和基于参数的 `needsApproval`。OpenAI-compatible provider 支持自定义 `baseURL`、请求体转换、流式输出、工具调用及提供方相关字段。

来源：

- [AI SDK：Building Agents](https://ai-sdk.dev/docs/agents/building-agents)
- [AI SDK：ToolLoopAgent](https://ai-sdk.dev/docs/reference/ai-sdk-core/tool-loop-agent)
- [AI SDK：Tools and Tool Calling](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling)
- [AI SDK：OpenAI Compatible Providers](https://ai-sdk.dev/providers/openai-compatible-providers)

建议用法：

- 保留现有 `AiSdkAgentModel` 作为 MiniMax provider adapter。
- 通用 Skill 统一使用 AI SDK tool schema，复用 Zod v4。
- 可以复用 AI SDK 的 tool approval 事件格式或思想，但最终授权判定仍走项目 `PermissionPolicy`。
- 第一阶段不要直接把产品 AgentCore 换成 `ToolLoopAgent`。

原因：

- `needsApproval` 只表达“这次工具调用要不要批准”，不能独立表达本项目的目录范围、账号范围、产品版本、意图版本、“允许一次/本任务允许”和旧授权失效规则。
- `ToolLoopAgent` 负责模型循环，但不是本项目持久化任务、幂等操作收据和不确定后台写入的完整来源。
- 当前 AgentCore 已有大量产品专用确定性准备、修复窗口、审批和恢复语义；替换风险远高于收益。

### 2. AI SDK MCP client / 官方 MCP TypeScript SDK：外部 Skill 采用，内置核心工具不必 MCP 化

AI SDK 官方建议：生产应用中自有工具优先使用进程内 AI SDK tools，以获得完整类型、低延迟和 Schema 控制；MCP 更适合运行时发现和用户自带工具。AI SDK 的轻量 MCP client 能转换 MCP tools，但官方说明其不覆盖完整会话管理、可恢复流和通知能力。官方 MCP TypeScript SDK 提供完整 client/server、stdio 和 Streamable HTTP transport、工具/资源/提示词协议。

来源：

- [AI SDK：MCP Tools](https://ai-sdk.dev/docs/ai-sdk-core/mcp-tools)
- [AI SDK：Tools and Tool Calling 中的 AI SDK tools 与 MCP 对比](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling)
- [MCP TypeScript SDK v2](https://ts.sdk.modelcontextprotocol.io/v2/)
- [MCP TypeScript SDK：Build your first client](https://ts.sdk.modelcontextprotocol.io/v2/get-started/first-client)

建议用法：

- 行程规划、本地文件、VBK、三人同游后台等内置能力继续用进程内 tools。
- “安装 Skill”“连接用户提供的外部工具”再使用 MCP。
- Electron 本地 Skill 优先 stdio；远程企业工具使用 Streamable HTTP。
- MCP tool 调用仍必须经过本地权限与动作执行层，不能因 MCP server 声明可写就直接放行。
- 待 MCP v2 与当前依赖兼容性验证后再锁定包版本；不要在首批 UI 改造中顺手引入。

### 3. LangGraph.js：能力匹配，但第一阶段不采用

LangGraph 提供 graph state、checkpoint、thread、重试、`interrupt()` 人工介入和恢复；官方还提供 SQLite checkpointer。这些能力与通用智能体的暂停/恢复很匹配。

来源：

- [LangGraph：Thinking in LangGraph](https://docs.langchain.com/oss/javascript/langgraph/thinking-in-langgraph)
- [LangGraph SQLite Checkpointer](https://reference.langchain.com/javascript/langchain-langgraph-checkpoint-sqlite)
- [LangGraph Checkpoint 概念](https://reference.langchain.com/javascript/langchain-langgraph-checkpoint)

暂不采用原因：

- 当前产品 Agent 已经拥有成熟的 snapshot、run、event、审批和恢复语义。
- LangGraph checkpoint 会形成第二套线程与状态模型，需要与现有 SQLite 产品事实双向映射。
- 如果 graph checkpoint 被当成事实来源，会模糊“当前持久化产品才是业务权威”的不变量。
- 仍需自己实现目录授权、账号写锁、版本失效、操作收据和外部写入核查，无法消除最关键的业务代码。

可选验证：后续用一个完全独立的“文件分析 → 请求写入授权 → 生成报告”原型评估 LangGraph，不能先迁移行程规划。

### 4. Mastra：首期不采用

Mastra 提供 Agent、workflow、存储、长期任务、暂停/恢复、MCP 和观测能力；官方存储层会保存 workflow snapshot、线程、长期 Agent 状态等。

来源：

- [Mastra：Storage](https://mastra.ai/docs/storage)
- [Mastra：MCP Connections](https://mastra.ai/docs/connections/mcp)
- [Mastra：Built-in MCP server](https://mastra.ai/docs/server/mcp)

暂不采用原因：

- 它是更完整的运行平台，会与 Electron 主进程、现有 SQLite、AgentCore、AI SDK 和操作日志重叠。
- 为使用少量 workflow 能力引入整套 storage/runtime/server 概念，增加部署与升级面。
- 当前应用是本地优先桌面程序，不需要 Mastra 的服务器与 Studio 体系来完成第一阶段。

### 5. Playwright：采用，继续复用，不引入第二套浏览器 Agent SDK

Playwright 的 locator 具有自动等待和重试能力，官方建议优先使用面向用户的角色、标签和文本定位。当前项目已经围绕 Playwright 建立生产后台适配器和安全执行逻辑。

来源：

- [Playwright：Locators](https://playwright.dev/docs/locators)

建议用法：

- 继续复用当前 `VbkBrowser`、BrowserView、账号会话和 `runVbkPageExclusive()`。
- 为三人同游后台新增独立 adapter 和 `accountKey`，共用上层动作执行接口。
- 模型不能直接生成任意 Playwright 代码执行；模型只选择受 Schema 限制的业务动作。
- 查询可以隐藏执行，写操作前展示真实页面并走权限门禁。

### 6. PptxGenJS：采用

PptxGenJS 官方支持 Node、React、Vite 和 Electron，可生成兼容 PowerPoint、Keynote、LibreOffice 和 Google Slides 导入的 OOXML `.pptx`，并支持文本、表格、图片、图表、Slide Master 和 Node 文件写入。

来源：

- [PptxGenJS：Introduction](https://gitbrent.github.io/PptxGenJS/docs/introduction/)
- [PptxGenJS：Saving Presentations](https://gitbrent.github.io/PptxGenJS/docs/usage-saving.html)
- [PptxGenJS：Charts](https://gitbrent.github.io/PptxGenJS/docs/api-charts/)

建议用法：

- 在 Electron 主进程生成 `.pptx`，renderer 只展示结构化预览与保存结果。
- 用项目模板封装 Slide Master、字体、颜色、页边距和图表样式，模型只生成受控的 presentation plan。
- 写文件必须经过任务目录授权和 `ActionExecutor`。
- PPT 预览需要另行选择渲染方案；PptxGenJS 负责生成，不负责高保真编辑器或原生 PowerPoint 渲染。

### 7. 本地文件：使用 Node/Electron 原生接口，不需要额外 Agent 文件 SDK

推荐复用 Node `fs/promises`、`path`、Electron `dialog`、现有 `mammoth` 和 `unpdf`。关键不是文件 SDK，而是安全的 scoped path resolver：

- 所有路径在主进程解析。
- 校验 realpath，阻止软链接越出授权根目录。
- 将读取、创建、修改、移动、覆盖、删除定义为不同动作。
- renderer 不直接获得任意文件系统能力。

这部分应是项目自有的小型 adapter，因为授权语义属于产品，而不是通用文件库。

## 推荐的最终技术栈

| 层 | 选择 | 决策 |
| --- | --- | --- |
| 模型与流式输出 | `ai` v7 + `@ai-sdk/openai-compatible` | 现有，继续采用 |
| 内置工具 Schema | AI SDK `tool()` + Zod | 采用 |
| 自动模型循环 | 当前自有 loop；局部评估 `ToolLoopAgent` | 不替换产品 Agent |
| 外部 Skill 协议 | 官方 MCP TypeScript client | 第二阶段采用 |
| 持久化 | 现有 `better-sqlite3` | 继续采用 |
| 后台自动化 | 现有 Playwright | 继续采用 |
| PPTX | PptxGenJS | 新增采用 |
| 文件访问 | Node/Electron 原生接口 | 自有薄 adapter |
| 权限与授权 | 自有 `PermissionPolicy` | 必须自研 |
| 操作幂等和收据 | 自有 `ActionExecutor` / receipt store | 必须自研 |
| LangGraph | 暂不引入；独立 spike 候选 | 观察 |
| Mastra | 不引入 | 拒绝 |

## “复用 SDK”后的自研边界

需要自己实现的不是通用 AI 基础设施，而是无法外包的产品语义：

1. `AgentThread` / `AgentRun` 的桌面任务模型。
2. 精确到目录、后台账号、动作类型和任务的权限范围。
3. 同一后台账号写操作串行化。
4. 计划动作、授权、执行结果和不确定写入的操作收据。
5. 行程方案程序检查、运营确认、录入授权失效等业务门禁。
6. 将现有产品 Agent 作为一个 Skill adapter，而不是重写它。

其余模型连接、工具调用协议、后台浏览器控制、MCP 互操作和 PPTX 格式生成均可复用成熟 SDK。

## 建议的实施顺序

1. 不新增 Agent 框架，先用现有 AI SDK + SQLite 完成通用任务、权限、动作收据和本地文件纵向闭环。
2. 新增 PptxGenJS，完成“文件 → 受控 presentation plan → `.pptx`”闭环。
3. 将现有行程规划 Agent 暴露为内部 Skill adapter。
4. 新增三人同游后台 Playwright adapter，复用统一动作执行接口。
5. 等内置 Skill 运行稳定后，再引入官方 MCP client，支持外部 Skill。
6. 仅当自有任务恢复逻辑明显变成图状态机维护负担时，再用独立原型评估 LangGraph。
