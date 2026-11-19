# 通用智能体工作台实施交接

更新时间：2026-11-16（第二阶段第 1–3 步完成，第 4 步只读部分、第 6 步、第 7 步协议层已落地）  
状态：对话骨架、工具运行时与事实模型、本地文件/演示文稿/网页/产品只读/账号只读 Skill、右侧工作面板与审批、继续运行、产物面板、MCP 外部工具均已真实可用；产品写入与确认、真实后台写入、MCP 配置界面仍未做。

## 阶段状态一览（截至 2026-11-17）

| 计划项 | 状态 | 证据 |
| --- | --- | --- |
| 第 1–3 步：运行时/本地文件/面板审批 | ✅ 完成 | 真实窗口端到端 + 全量回归 |
| 第 4 步：行程规划 Skill | ✅ 只读部分完成；写入选 **A 永久不做** | `assertProductActionsReadOnly` 装配期守卫 |
| 第 5 步：后台操作 | 🟡 只读完成（登录状态/联系人/POI，真实后台验过）；产品写入已按决策 A 落地第一个动作（门禁=程序检查+运营确认） | `skills/vbk-readonly/`、`skills/vbk-write/`、写入门禁 |
| 第 6 步：PPT / 网页 | ✅ 完成 | python-pptx 结构校验 + 应用内预览实测 |
| 第 7 步：MCP 外部 Skill | ✅ 协议层与配置界面完成 | 真实 stdio 子进程 + 设置页卡片 |

待用户输入才能继续的两件事：① 一次受控真实写入（需要在场确认，见 [VBK 写入实施计划](/Users/cisco/Documents/vbk-auto/docs/general-agent-vbk-write-plan.md)）；② 三人同游后台的 Token 免登录方案（由业务侧设计，尚未提供）。

2026-11-17 已确认：VBK 后台写范围 = 该账号权限内的所有信息；三人同游后续走 Token 免登录，当前不实现 adapter。

## 本阶段交付清单（2026-11-17 收口）

**新增模块**
- `src/main/agent-runtime/`：`skill-registry` / `permission-policy` / `path-scope` / `action-executor` / `run-loop` / `run-service` / `artifacts` / `skill-scope` / `mcp/*` / `skills/{local-file,deck,web,product-readonly,account-readonly,vbk-readonly,vbk-write,tibet-readonly,backend-write-guard}`
- `src/main/agent-workspace/`：`service` / `ports` / `external-tools` / `external-tools-settings` / `model-context` / `vbk-adapter` / `vbk-write-adapter`
- `src/renderer/app/views/agent/`：`AgentHome` / `ThreadSidebar` / `AgentThreadView` / `AgentWorkPanel` + `AgentWorkPanelRows` / `ArtifactPreviewModal` / `skill-scope`
- `src/renderer/app/views/settings/agent-tools-block.tsx`（MCP 配置卡片）
- 迁移 `0019_agent_runtime` / `0020_agent_receipt_artifact` / `0021_agent_thread_enabled_skills`
- 新增依赖 `pptxgenjs`、`@modelcontextprotocol/sdk`

**验证证据**
- `npm run test:all` 全量通过（含浏览器层与集成层），强制 5 项正向 + 20 项负向收据通过；
- 真实 Electron 窗口端到端：任务 → Skill 启停 → 真实模型只读查询 → 生成 PPT 停在审批 → 真实拒绝 → 网页生成并应用内预览；
- 真实 VBK 后台只读：会话状态、50 个联系人卡片、10 个 POI 候选；
- 打包 `.app` 实测：asar 内 `pptxgenjs` 与 MCP SDK 可解析，应用正常启动。

**仍未做**
- 一次受控真实 VBK 写入（需运营在场指定产品并认可改动）；
- 三人同游 adapter（等业务侧 Token 免登录方案）；
- 产品域其余写动作（资源绑定 / 换封面 / 发布）与 Skill 版本管理。

> **续做请先读 [续做交接（面向下一个执行模型）](/Users/cisco/Documents/vbk-auto/docs/general-agent-continuation-handoff.md)**：
> 那里有当前提交状态、模块地图、验证命令、真实窗口调试方法与待办。本文保留需求来源、产品决策与原始实施步骤。

## 接手入口

开始实施前，按顺序完整阅读：

1. 根目录 `AGENTS.md`：代码行数、业务状态机、25 项强制 E2E 和高风险操作红线均为硬约束。
2. `DESIGN.md`：沿用当前浅色、紧凑、桌面工作台设计语言。
3. `docs/general-agent-sdk-evaluation.md`：SDK 结论和自研边界已经确定。
4. [当前实现细节](/Users/cisco/Documents/vbk-auto/docs/general-agent-current-implementation.md)：哪些能力已经真实可用、关键不变量与边界。
5. 本文“尚未实现”“下一阶段实施步骤”和“验收要求”。

完成标准：能解释哪些能力已经真实可用、哪些只是 UI 入口，并确认不会以通用智能体绕过产品规划门禁。

## 产品决策

- 页面名称为“智能体”；原“任务中心”名称为“自动化运行”。
- 采用 Codex 风格三栏：全局导航、最近任务、主工作区。
- 最近任务位于左侧第二列，支持搜索、重命名、置顶、归档和恢复。
- 行程规划是预装 Skill，不是通用智能体的特殊首页。
- 首批后台为 VBK 和三人同游。
- 文件权限按任务绑定目录；读取可静默执行，写入必须可见并留下收据。
- 普通任务可并行；同一后台账号的写操作必须串行。
- 右侧工作面板仅在检查详情、请求授权或展示产物时打开。
- PPT 产物必须是可编辑 `.pptx`，支持应用内预览和后续对话修改。
- 使用成熟 SDK：现有 AI SDK、Playwright、SQLite；PPT 使用 PptxGenJS；外部 Skill 后续接 MCP。
- 首期不引入 LangGraph 或 Mastra，不建立第二套任务事实来源。

## 不可破坏的不变量

产品业务的唯一允许状态流转仍是：

```text
行程规划（可多轮对话） → 程序检查 → 运营确认 → 行程录入
行程录入发现新问题 → 行程规划 → 程序检查 → 运营确认 → 行程录入
```

通用智能体只能调用现有产品 Agent/服务作为 Skill adapter。修订方案后必须失效旧检查、旧确认和旧录入授权。不得让模型、通用审批或操作收据替代任何一道产品门禁。

写后台还必须满足：明确动作、当前对象版本、当前账号、授权范围和操作收据一致。同一账号只允许一个写操作进入执行区。

各阶段「已经真实可用」的部分、关键不变量与已知边界，见 [当前实现细节](/Users/cisco/Documents/vbk-auto/docs/general-agent-current-implementation.md)。

## 尚未实现

- Skill 版本管理与外部安装（任务级启停已可用）。
- 跨任务的排队优先级与配额（串行与队列可见性已实现：同账号写操作 FIFO，面板能看到持锁任务与排队数）。
- 产品写入/确认/录入类的通用 Skill——**已决策永久不做**（A，代码守卫 `assertProductActionsReadOnly`）。
- 后台**写**的其余动作（资源绑定 / 换封面 / 发布）与真实受控写入验证：第一个写动作已按决策 A 落地，计划见 [VBK 写入实施计划](/Users/cisco/Documents/vbk-auto/docs/general-agent-vbk-write-plan.md)。
- 三人同游 adapter：只读部分已落地（service token + 公共在售目录 + 令牌自检，见 [当前实现细节](/Users/cisco/Documents/vbk-auto/docs/general-agent-current-implementation.md) 第 8 步）；需要身份绑定的个人数据与写入仍未做。
- 附件上传与幻灯片缩略图渲染（PPT 只有生成与收据，没有应用内图形预览；本机无 LibreOffice/PowerPoint 渲染器，不做假实现）。
- MCP 配置的持久化细节（断开状态只在本次会话有效，重启按配置重连）。
- MCP 外部 Skill 的"安装/分发"（连接与配置已可用，但没有市场或一键安装）。
- 语义摘要、多级长期记忆和用户可编辑记忆面板。

首页入口已与真实能力对齐：`agentWorkspace:capabilities()` 驱动「推荐开始」，未安装标「未安装」、未接入（操作后台）标「尚未接入」并禁用。

## 下一阶段实施步骤

进度：第 1–3 步完成；第 4 步只读部分完成、写入按决策 A 永久不做；第 5 步只读部分完成、写入范围待定；第 6、7 步完成。下面保留原始步骤与完成标准，未完成项见「尚未实现」。

### 1. 建立工具运行时与事实模型

新增深模块，建议职责如下：

```text
agent-runtime/
  skill-registry       预装 Skill 元数据、输入 Schema、能力与风险声明
  run-service          多步运行、暂停、恢复、取消
  permission-policy    目录、账号、动作和授权时效判定
  action-executor      写锁、幂等执行、收据和不确定结果核查
```

持久化至少区分 `AgentThread`、`AgentRun`、`ToolCall`、`PermissionGrant`、`ActionReceipt`。线程保存用户意图；运行保存一次执行；收据保存外部世界实际发生的结果。模型输出不是事实来源。

完成标准：一个测试 Skill 能经历“计划 → 请求授权 → 授权 → 执行 → 收据 → 恢复对话”；应用重启后能从 SQLite 恢复；重复提交同一幂等键不会重复写入。

### 2. 完成本地文件纵向闭环

使用 Node `fs/promises`、`path` 和 Electron `dialog`。所有路径在主进程解析，并以授权目录的 `realpath` 为根校验目标 `realpath`；软链接、`..` 和不存在目标的父目录都不能越界。

动作分成：列目录、读取、创建、修改、移动、覆盖、删除。读取可直接执行并记审计；所有写动作先展示目标、差异或结果预览，再按权限策略授权。删除优先使用可恢复方式。

完成标准：正向测试覆盖目录内读写；负向测试覆盖绝对路径越界、`..`、软链接越界、授权失效、重复写和删除；每个写操作都有可回读收据。

### 3. 接入右侧工作面板和审批

面板状态建议只由运行事实驱动：`inspection`、`approval`、`artifact`。普通对话不常驻第三面板。审批必须展示 Skill、动作、目标、账号/目录、预计影响和授权范围选项。

完成标准：读操作不打断对话；写操作停在可恢复的审批点；拒绝后运行明确结束或返回可修改计划；重开任务仍能看到审批和收据历史。

### 4. 将行程规划暴露为预装 Skill

adapter 只调用现有产品创建、规划、程序检查、运营确认和录入服务。产品数据库仍是业务事实来源，通用线程只保存引用、运行和展示信息。

完成标准：从智能体创建产品后仍完整经过既有状态机；方案修改会失效旧授权；原 5 项正向与 20 项负向 E2E 一项不少且结果不变。

### 5. 接入后台操作

复用现有 Playwright、VBK 登录会话、BrowserView 和独占执行设施。为三人同游新增独立 adapter 与 `accountKey`。模型只能选择受 Schema 约束的业务动作，不能生成任意 Playwright 代码执行。

查询默认后台执行；写入前打开真实页面或等价检查面，经过授权后由 `ActionExecutor` 串行执行。超时或页面状态不明时标记 `uncertain`，先回读核查再决定是否重试。

完成标准：同一账号的两个写任务串行，不同账号可并行；重试不会重复提交；每次写入有前置状态、结果和核查收据。

### 6. 接入 PPT 与网页 Skill

新增 PptxGenJS。模型先输出受 Zod 约束的 presentation plan，再由模板渲染可编辑 `.pptx`；文件写入统一走目录授权与动作收据。预览与生成分层，PptxGenJS 不承担原生 PowerPoint 渲染。

网页 Skill 同样先形成结构化计划，在授权目录生成工程；生成后把文件树、预览入口和修改记录放入产物面板。

完成标准：PPT 可在 PowerPoint/Keynote 打开并编辑，应用中有可核对预览；对话修改只更新目标产物且产生新版本。网页可本地预览，写入均受目录权限约束。

### 7. 最后接入 MCP 外部 Skill

内置 Skill 稳定后再引入官方 MCP TypeScript client。外部工具的调用仍先转换为本地 `ToolCall`，统一经过 `PermissionPolicy` 和 `ActionExecutor`；MCP server 的能力声明不能直接授予写权限。

完成标准：连接、断开、超时和 Schema 变化可诊断；外部写工具与内置写工具使用同一审批和收据路径。

## 推荐运行状态

```text
queued → running → waiting_approval → running → completed
                  ↘ rejected
running → needs_attention → running
running → cancelled
外部结果不确定 → uncertain → 核查后 completed/failed
```

`waiting_approval` 必须是可持久化暂停点。`uncertain` 必须禁止盲目重试写操作。

## 验收要求

每次代码或运行配置变动均执行：

```bash
npm run test:changed
```

运行器必须打印：

```text
[test] 强制产品回归执行核验：5 项正向 + 20 项负向全部通过，无漏跑或跳过。
```

若收据没有完整收集 25 项，补跑 `npm run test:e2e`。同时执行与新增模块相关的目标测试、类型检查和构建。交付报告必须分别写明：

- 5 项正向是否全部通过门禁并到达 `waiting_approval`，是否产生本次新 `pendingApproval`。
- 20 项负向是否全部被生产门禁拦截，且无审批事件和 `pendingApproval`。
- 网络尝试和真实携程写入均为 0。
- 所有新增或修改文件 `wc -l` 不超过 350。

第二阶段基线（2026-11-16）：`npm run test:changed` 共 3068 项、3068 通过、0 失败、0 跳过；强制 5 项正向 + 20 项负向收据通过。`npm run build` 通过，仅有既存的大 chunk 警告。本阶段新增 28 项运行时测试（运行循环 5、执行器与权限策略 5、路径越界 5、本地文件 Skill 3、产品只读 Skill 5、持久化 5）。

加入新依赖（`pptxgenjs`、`@modelcontextprotocol/sdk`）后的全量基线：`package.json` 属于测试选择器的全局运行文件，因此这些次 `npm run test:changed` 执行了全部套件——最近一次共 **4450 项、4450 通过、0 失败、0 跳过**，强制 5 项正向 + 20 项负向收据通过；`npm run build` 通过。本阶段新增测试合计 156 项（运行时 28 + 演示文稿 4 + 网页 6 + 产物 4 + 工作面板 7 + 继续运行 5 + 账号只读 7 + MCP 6 + 外部工具 6 + MCP 设置面 5 + Skill 作用域 11 + 写队列 4 + 目录健康 2 + 运行历史 3 + 单服务开关 4 + 产物预览 7 + 首页能力 3 + transcript 回收 3 + 文档一致性 4 + VBK 只读 19 + 产品只读守卫 1 + 后台写准入 5 + VBK 写入 5 + 写入门禁 5 + 写入前置状态 2）。

真实窗口端到端验证：`electron .` + vite dev + Playwright CDP 已跑通"新建任务 → Skill 启停 → 真实模型只读查询并落收据 → 生成 PPT 停在审批 → 真实点击拒绝"，细节见 [当前实现细节](/Users/cisco/Documents/vbk-auto/docs/general-agent-current-implementation.md)。

顺带修掉的测试网缺口：`test/infrastructure/ipc-coverage.test.ts` 的注册器清单漏了 `src/main/ipc/agent-workspace-ipc.ts` 与 `src/main/ipc/planning-ipc/ipc-handlers.ts`，导致通用智能体的 10 个 channel（含第一阶段的 6 个）一直不在"preload 与 main 是否一致"的检查范围内；改依赖触发全量运行后才暴露，已补进清单。

另一处顺带修掉的缺陷：工作面板的可见性判定只认"审批 / 活跃运行 / 工具调用"，运行结束后若工具调用滚出 20 条窗口，只剩产物的任务会连面板一起消失。现在把"成功收据登记了产物"也算作可见理由，并加了面板渲染契约测试（`test/agent/agent-work-panel.test.ts`）。

第一阶段最后一次基线：`npm run test:changed` 共 3040 项通过、0 失败、0 跳过；强制 5+20 收据通过。

排序教训：线程消息、运行、工具调用、授权与收据一律按 `rowid`（插入序）取序。先前用 `created_at,id` 排序时，同一毫秒内的写入会退化成随机 UUID 排序，实测导致"用户消息排在助手消息之后"，使门禁在两次独立运行里各失败一次；已修正并加回归测试（含 600 次快速插入的压力验证）。

新增/修改文件行数自查：本阶段 `src/main/agent-runtime/**`、`src/main/agent-workspace/**`、`src/renderer/app/views/agent/**`、`src/shared/contracts-agent-*.ts`、`src/main/infrastructure/database/{parts,database}/*agent-runtime*` 与全部新增测试均 ≤350 行。

## 工作区保护

本阶段没有 commit、push 或发布。接手时先运行 `git status --short`，保留所有未提交内容。

本通用智能体阶段拥有的新增区域主要是：

- `docs/general-agent-sdk-evaluation.md`
- `docs/general-agent-implementation-handoff.md`
- `src/main/agent-workspace/`（`ports.ts` 只读端口，`external-tools.ts` MCP 连接，`model-context.ts` 系统提示与 provider）
- `src/main/agent-runtime/`（第二阶段新增，含 `skills/local-file/`）
- `src/main/infrastructure/database/database/agent-workspace.ts`
- `src/main/infrastructure/database/database/agent-runtime.ts`
- `src/main/infrastructure/database/parts/agent-workspace.ts`
- `src/main/infrastructure/database/parts/agent-runtime.ts`
- `src/main/infrastructure/database/parts/agent-runtime-approval.ts`
- `src/main/infrastructure/database/parts/agent-runtime-migration.ts`
- `src/main/ipc/agent-workspace-ipc.ts`
- `src/renderer/app/views/agent/`（`AgentWorkPanel.tsx` 只放面板骨架，行组件在 `AgentWorkPanelRows.tsx`）
- `src/shared/contracts-agent-workspace.ts`
- `src/shared/contracts-agent-runtime.ts`
- `test/agent/agent-workspace-context.test.ts`
- `test/agent/agent-runtime-loop.test.ts`
- `test/agent/agent-runtime-executor.test.ts`
- `test/agent/agent-runtime-path-scope.test.ts`
- `test/agent/local-file-skill.test.ts`
- `test/agent/deck-skill.test.ts`
- `test/agent/web-skill.test.ts`
- `test/agent/agent-artifact.test.ts`
- `test/agent/agent-work-panel.test.ts`
- `test/agent/agent-runtime-resume.test.ts`
- `test/agent/account-readonly-skill.test.ts`
- `test/agent/mcp-skill.test.ts`
- `test/agent/external-tools.test.ts`
- `test/agent/agent-skill-scope.test.ts`
- `test/agent/skill-scope-ui.test.ts`
- `test/agent/agent-skill-strip.test.ts`
- `test/agent/agent-write-queue.test.ts`
- `test/agent/agent-directory-health.test.ts`
- `test/agent/agent-run-history.test.ts`
- `test/agent/agent-artifact-preview.test.ts`
- `test/agent/artifact-preview-modal.test.ts`
- `test/agent/agent-home-capabilities.test.ts`
- `test/agent/agent-run-transcript-lifecycle.test.ts`
- `test/agent/agent-docs-consistency.test.ts`
- `test/agent/vbk-write-skill.test.ts`
- `test/agent/vbk-write-gate.test.ts`
- `test/fixtures/mcp/fixture-server.mjs`
- `test/infrastructure/agent-workspace.test.ts`
- `test/infrastructure/agent-runtime.test.ts`

本阶段还修改了数据库 facade/types/migration、主 IPC/preload、共享契约、workspace-home、Rail、Topbar、自动化运行标题以及两处 UI 契约测试。编辑这些文件时按 diff 精确保留并行改动。

以下脏改动在本阶段开始前已存在或来自并行工作，不属于通用智能体实现，不能清理、覆盖或顺手重构：AI 模型/供应商设置、MiniMax 设置与测试、旧产品 `agent-conversation`/`review`、`ai-test-receipts.ts`、`agent-model-select.tsx`、登录状态与 collection refresh 相关变更。以接手时实际 diff 为准。

高风险动作遵循 `AGENTS.md`：只有用户明确授权后才能 commit、push、发布、部署、删除或强制覆盖。
