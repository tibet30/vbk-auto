# 通用智能体当前实现细节

续做入口是 [续做交接](/Users/cisco/Documents/vbk-auto/docs/general-agent-continuation-handoff.md)。本文件是 [交接文档](/Users/cisco/Documents/vbk-auto/docs/general-agent-implementation-handoff.md) 的实现细节附录：
记录各阶段「已经真实可用」的部分、关键不变量与仍未做的边界。
交接文档只保留入口、业务不变量、验收要求与实施步骤。

## 第一阶段当前实现

### 任务与对话

- `src/shared/contracts-agent-workspace.ts`：任务、消息、摘要、上下文和 IPC 类型。
- `src/main/infrastructure/database/parts/agent-workspace.ts`：按用户隔离的线程和消息持久化。
- `src/main/infrastructure/database/parts/migration-registry.ts`：迁移 `0018_agent_workspace`。
- `src/main/agent-workspace/service.ts`：通用对话、自动标题、运行状态和明确记忆捕获。
- `src/main/agent-workspace/workspace-directory.ts`：工作目录来源判定，临时工作区的创建、回收与启动清理。
- `src/main/ipc/agent-workspace-ipc.ts`：任务 CRUD、发送消息和目录选择 IPC。
- `src/main/preload.cts`、`src/shared/contracts-api.ts`：renderer 桥接。

当前真实能力：创建、搜索、打开、置顶、归档、删除任务；列表默认只渲染最近 20 条，滚动到底部或点「加载更多」继续加载；不提供重命名入口。持久化完整消息；调用现有模型完成无工具对话；为任务保存一个工作目录；未指定目录的任务在首次执行前自动获得临时工作区（见下方「临时工作区」）。

（第一阶段结束时）目录字段只是授权范围的记录，还没有文件读取或写入工具。第二阶段已补齐工具运行时与本地文件闭环，**当前状态看下方「第二阶段当前实现」**；"没有收据不得声称已完成"这条系统提示一直保留到今天。

### 记忆、摘要与压缩

- `src/main/agent-workspace/context-compression.ts` 保存确定性压缩逻辑。
- 数据库始终保留完整原始消息；压缩只影响发送给模型的上下文。
- 默认保留最近 24 条消息，预算约 8,000 tokens，至少保留最后 4 条。
- 较早消息生成版本化摘要；助手回复后立即刷新摘要。
- 用户明确表达“记住”时复用现有 `MemoryService`；模型上下文会加载已确认长期记忆。

限制：当前摘要是确定性摘录，不是语义摘要；长期记忆沿用现有全局作用域，尚未补齐“任务/后台账号/组织”多级作用域和记忆管理 UI。

### 界面

- `src/renderer/app/views/agent/index.tsx`：工作区容器和任务协调。
- `ThreadSidebar.tsx`：最近任务第二列；首屏 20 条，滚动触底增量加载；每行保留置顶/归档/删除，删除会清掉该任务的消息、运行、工具调用、授权与收据，执行中的任务不允许删除。
- `AgentHome.tsx`：紧凑首页、推荐入口和快速跳转。
- `AgentThreadView.tsx`：消息、摘要、目录和输入区。
- **新建任务只回到首页**：点「新建任务」把主区域切回首页输入框，每次都是空白草稿，不落库空白任务——任务记录在第一条消息发出时才创建，任务列表因此不会留下没内容的任务。新建 / 切换 / 归档都会推进视图代次，在途运行或刷新回包若已过期只更新列表，不会把用户拽回对话。
- `src/renderer/app/views/workspace-home/index.tsx`：挂载智能体；VBK 登录打开时仍保持原独占登录面。
- `Rail.tsx`、`Topbar.tsx`、`views/tasks/index.tsx`：名称更新。

交互原型位于：

```text
/Users/cisco/.codex/visualizations/2026/11/16/01a1e1ee-da5d-7863-8fad-f4e388b8b977/agent-workspace-mockup.html
```

原型是设计参考，不是生产实现的事实来源。

## 第二阶段当前实现（下一阶段第 1–3 步）

### 事实模型与持久化

迁移 `0019_agent_runtime` 新增四张表，各自只承担一类事实：

| 表 | 语义 |
| --- | --- |
| `agent_runs` | 一次执行的意图、步数、状态与工具往返 `transcript_json` |
| `agent_tool_calls` | 模型提出的一次受 Schema 约束的动作，含审批状态与 `idempotency_key` |
| `agent_permission_grants` | 运营给出的授权：作用域、动作、目标、撤销状态 |
| `agent_action_receipts` | 外部世界实际发生的结果，`idempotency_key` 唯一；`artifact_json` 记录结构化产物（迁移 `0020`） |

运行状态固定为 `queued → running → waiting_approval → running → completed`，另有 `rejected / cancelled / uncertain / needs_attention / failed` 分支。`waiting_approval` 与 `uncertain` 都是以 SQLite 为事实来源的持久化暂停点。

### 运行时模块 `src/main/agent-runtime/`

| 文件 | 职责 |
| --- | --- |
| `skill-registry.ts` | Skill 元数据、工具 Schema 与动作解析的唯一注册表 |
| `permission-policy.ts` | 目录、动作、目标与授权时效判定 |
| `path-scope.ts` | 以授权目录 `realpath` 为根的目标校验 |
| `action-executor.ts` | 同账号写锁、幂等执行、收据与 `uncertain` 收敛 |
| `run-loop.ts` | 多步模型—工具循环；一轮只推进一个动作以保证暂停点可恢复 |
| `run-service.ts` | 开始 / 批准 / 拒绝 / 取消 / 中断恢复与只读快照 |
| `skills/local-file/` | 列目录、读取、新建、修改、覆盖、移动、删除七类动作 |
| `skills/deck/` | 结构化大纲 → 可编辑 `.pptx`（第 6 步） |
| `skills/web/` | 结构化计划 → 静态网页工程（第 6 步） |
| `skills/product-readonly/` | 产品列表与就绪结论的只读查询（第 4 步） |
| `skills/account-readonly/` | 本机 VBK 账号记录与账号固定信息的只读查询（第 5 步可离线部分） |
| `skills/tibet-readonly/` | 三人同游服务端令牌状态与公共在售目录的只读查询（第 8 步） |
| `mcp/` | 外部 MCP 工具：stdio 连接、工具桥接、发现诊断（第 7 步） |

默认注册表：`local-file` + `deck` + `web`；MCP 工具由 `ExternalToolRuntime` 从设置键 `agentMcpServers` 发现后作为 `extraSkills` 追加；装配时若传入只读端口，再前置 `account-read` / `product-read`（端口在 `src/main/agent-workspace/ports.ts` 里从本机 cookie 记录、账号固定信息与产品库投影，不新增事实）。新增依赖 `pptxgenjs@^4.0.1`，`yarn.lock` 已同步（`package-lock.json` 被 `.gitignore` 忽略）。

排序约定：线程消息、运行、工具调用、授权与收据都是追加写账本，一律按 `rowid`（插入序）取序；`created_at` 只用于展示。用 `created_at` 排序时，同一毫秒内的两条消息会退化成随机 UUID 排序，实测出现过对话顺序反转，时钟回拨也会打乱历史顺序。

关键不变量：

- 读取在授权目录内静默执行，但仍写入审计收据；写入与删除默认必须审批。
- 授权分 `once`（只覆盖该次工具调用）与 `thread`（覆盖授权目录内的同类动作）。更换工作目录或归档任务会立即撤销该任务的全部旧授权。
- 同一 `accountKey` 的写动作串行进入执行区，不同账号可并行；同一 `idempotencyKey` 只会产生一次写入与一张收据。
- 执行中断或结果不明时停在 `uncertain`，必须回读核查后才能收敛为 `succeeded`/`failed`，禁止直接重试写操作。
- 应用启动时把中断在 `executing` 的动作转 `uncertain`，把 `queued/running` 的运行退回 `needs_attention`。

### 真实窗口端到端验证（2026-11-16）

用 `electron .` + vite dev + Playwright CDP 在真实窗口里跑通了整条链路（dev 用户数据目录隔离在 `三人同游-dev`）：

- 新建任务（带授权目录）→ Skill 芯片列出 5 个真实 Skill（产品只读 / 本机账号 / 本地文件 / 演示文稿 / 静态网页）；
- 真实点击停用「本地文件」→ `enabledSkills` 落库、芯片变灰、提示"已停用部分能力"；
- 真实模型调用（本机已配置密钥）→ 自动调用 `product.list`（读真实产品库 30 条）并落审计收据，面板显示「动作 / 收据 / 已完成 第 2/12 步」；
- 让模型生成 PPT → 运行停在 `waiting_approval`，面板审批卡展示 Skill／动作／目标／账号／授权目录／预计影响／4 页大纲预览／三种授权范围，授权目录仍为空；
- 真实点击「拒绝」→ 运行 `rejected`、动作 `denied`、审批卡消失、系统消息记录、目录仍为空；
- 授权目录不存在时运行会 fail-closed 并给出"授权目录不可用"，模型也会如实说明没有生成。**由此发现并修掉一个 UX 缺口**：任务目录不可用时界面此前毫无提示，现在 `AgentThreadWorkspace.workingDirectoryAvailable` 会驱动头部标黄提示「目录不可用」。

### 运行中间态的回收

`agent_runs.transcript_json` 是**运行期中间态**（模型往返消息），终态后即无用：
完成 / 被拒绝 / 被取消时清空，审计仍由 `agent_tool_calls` 与 `agent_action_receipts` 承担。
`waiting_approval`、`needs_attention`、`uncertain` 必须保留——恢复与继续都依赖它。
好处是长期使用时 SQLite 不会被历史 transcript 无界撑大。

### 临时工作区（2026-11-19）

生成 PPT、网页或文件前不再要求用户先选目录：任务没有工作目录时，首次执行（发送消息、继续、批准写动作、核查）前自动创建任务级临时工作区，并写回 `agent_threads.working_directory`。

- 落点：`<userData>/agent-workspaces/<ownerUserId>/<threadId>`。选应用数据目录而不是系统 `tmp`，因为产物（`.pptx`、网页工程）在任务结束前属于交付物，系统清理策略下会静默丢失；需要换位置时用 `VBK_AGENT_WORKSPACE_ROOT` 或构造参数覆盖。2026-11-19 用户已确认保持这个落点（方案 A），并由全局门禁 GATE-027 拦回系统临时目录的回退改动。
- 来源判定只看路径是否等于该任务的标准临时路径（`ThreadWorkspaceDirectory.kind`）：用户自己选中、恰好同名前缀的目录永远不会被当成临时目录处理。
- 回收：删除任务时删除临时工作区；应用启动时清理没有任何任务引用的临时目录。用户选择的目录只记录、不清空；临时目录切换成用户目录后旧目录在下一次启动清理时回收，不自动迁移产物。
- 临时目录被外部清掉后，下一次执行会重建同一路径；用户目录丢失仍按原语义报"目录不可用"，不静默回落到临时目录。
- 界面上目录按钮显示「临时工作区 · 路径」并在 tooltip 说明回收规则；未创建时显示「临时工作区（执行时自动创建）」。

范围与验收：`src/main/agent-workspace/workspace-directory.ts` + `workspace-view.ts` + `workspace-artifacts.ts`，测试见 `test/agent/temporary-workspace.test.ts` 与 `test/agent/agent-directory-health.test.ts`（创建、丢失重建、删除回收、启动清理、用户目录不动、界面标注）。规划与未做项见 [临时工作区规划](/Users/cisco/Documents/vbk-auto/docs/plans/2026-11-19-agent-temporary-workspace.md)。

### 打包产物验证（asar 内依赖解析）

`npm run package:mac:dir` 打包后用 `VBK_USER_DATA_DIR` 指向临时目录启动真实的 `.app`（不碰用户数据），验证：

- asar 内含全部新增运行时依赖：`pptxgenjs`（7 项）、`@modelcontextprotocol/sdk`（219 项）、`jszip`、`image-size`，以及既有的 `better-sqlite3`、`playwright`；
- 打包应用正常启动：主进程模块图会在启动时 **eager 加载** `pptxgenjs`（deck Skill）与 MCP SDK（mcp/client），因此能启动即证明两者在 asar 内解析成功；
- `window.vbk` 桥接存在，`agentWorkspace.capabilities()` 返回当时注册的全部 Skill（2026-11-16 那次为 5 个：product-read / account-read / local-file / deck / web；第 8 步新增 tibet 后为 6 个），渲染进程正常显示应用账号登录门；
- 启动日志里的 `[memory] maintenance skipped`（"请先登录应用账号后再保存记忆"）是未登录时**有意跳过**的后台维护，不是异常。

未覆盖：打包模式下走完整"生成 PPT"需要登录 + 模型密钥，该路径在开发模式已用 python-pptx 验证过，代码同一份。

### 文档与代码的一致性守卫

`test/agent/agent-docs-consistency.test.ts` 把交接文档里的声明变成断言：引用到的本地文档与源码路径（含 glob 前缀）、声明的迁移 id、提到的 `agentWorkspace:*` 通道（必须既注册又在 preload 绑定）、列出的 `skills/<name>/` 目录，全部要能对上代码。文档一脱节，测试就红。

### 首页入口与真实能力对齐

首页「推荐开始」不再是一组静态提示：`agentWorkspace:capabilities()` 返回已安装 Skill 与外部工具状态，入口按此渲染。

- 有对应 Skill → 可点（`data-state="ready"`），点击填入示例目标；
- 没有对应 Skill → 虚线边框 + 「未安装」并禁用；
- 根本没有该能力的入口（例如「操作后台」，后台 Skill 尚未接入）→ 明确标「尚未接入」并禁用，不让界面替不存在的功能承诺可用；
- 能力清单尚未加载完成时不显示为可用。

### 网页产物应用内预览

网页产物在面板里多了「预览」按钮：主进程读出入口 HTML，把同目录被引用的样式表内联后返回，渲染层用 **`sandbox=""` 的 iframe** 承载（不执行脚本、不给同源权限），模型生成的页面碰不到应用。

- 只支持目录型产物（网页工程）；演示文稿等文件型产物明确提示"请用系统程序打开"——本机没有 LibreOffice/PowerPoint 渲染器，PPT 缩略图不做假实现。
- 样式引用逐个走 `resolveScopedPath`，`../` 或绝对地址等越界引用一律丢弃并保留原样。
- 超过 512KB 的内容截断并标注，避免把巨型文件送进渲染进程。
- 预览同样只认"本任务成功收据登记的产物"，跨任务或未登记的收据直接拒绝。

### 运行历史

`AgentRuntimeSnapshot.runs` 给出最近 10 次运行（倒序），面板新增「历史运行」区块：时间、状态徽标、意图摘要、步数，展开可看结束原因（例如模型故障或运营拒绝）。

- 当前运行由顶部状态区承担，历史里不重复；只有一次运行时不显示该区块。
- 多轮任务即使当前没有动作与产物，面板也会出现——否则"之前跑过什么"无从查起。

### 写队列可见性

同一后台账号的写操作在执行器内串行（进程内 FIFO），但此前"谁在写、谁在排队"完全不可见。
现在 `ActionExecutor` 记录每个账号的队列状态（`running` / `waiting` / `since` / 持锁任务 id），
经 `AgentRuntimeSnapshot.writeQueues` 送到面板：

- 队列键包含 owner 前缀以保证隔离，**展示用的账号键不带前缀**；
- 面板出现「写入队列」区块：正在写 / 排队中、排队数量、持锁任务 id 前 8 位；
- 只要有写队列，面板就会显示——即使当前任务自己是排队方，也能看到是别的任务占着账号；
- 状态只用于诊断展示，不参与调度判定，队列空后立即回收。

### 任务级 Skill 启停

- 迁移 `0021_agent_thread_enabled_skills`：`agent_threads.enabled_skills_json`。`NULL` = 全部启用（历史与新建任务的默认语义），空数组 = 一个都不启用——两者不能混为一谈，测试专门盯这条。
- `agent-runtime/skill-scope.ts`：`scopeSkills` / `registryForScope` 按任务裁剪注册表；未知 id 忽略（配置里残留的旧 Skill 不该让整轮运行失败）。**未设置时直接复用全量注册表实例**，不会每次发消息都新建。
- 运行时按任务作用域取工具定义：被停用的 Skill 在模型侧完全不可见，模型即使硬调也会得到"未知工具"，不会登记为动作、不产生收据。
- 审批与核查仍按全量注册表解析——Skill 事后被停用不能让已提出的动作失去归属。
- 界面：对话页头部下方一条 Skill 芯片，逐个启停；把最后一个停用的重新打开时回到"全部启用"（`null`），避免把默认值固化成显式清单，导致以后新增 Skill 对老任务不可见。

### 界面

- `AgentWorkPanel.tsx` + `panel.module.less`：右侧工作面板只在存在运行事实时出现（有审批、有运行、或有工具调用），展示运行状态、审批卡（Skill／动作／目标／账号／授权目录／预计影响／差异预览／风险等级）以及动作与收据历史。
- 审批按钮为「仅本次允许」「本任务内允许该目录」「拒绝」；运行中可「取消运行」；状态为「结果不确定」的动作提供「核查结果」按钮。
- **继续运行**：运行停在 `needs_attention`（模型故障、撞步数上限、中断恢复）时，面板提供「继续运行」，从持久化的 transcript 接着跑，并自动补足步数预算；`waiting_approval` 必须先批准/拒绝、`uncertain` 必须先核查、transcript 停在未补结果的工具调用时也拒绝继续——这三种情况都不能"跳过门禁继续"。
- 不确定写入的核查走 `agentWorkspace:reconcile`：只读回读后把收据单向收敛为成功/失败，并把结论写入任务历史（`system` 消息），运行回到「需要处理，可继续」。核查本身仍无法判定时保持 `uncertain`，不猜成功、不允许重试。
- 审批卡与收据历史来自 SQLite 快照，重开任务与重启应用后仍然可见。
- **产物面板**：成功收据里登记的产物单独成段，展示文件/文件夹、文件树、总字节与预览入口，并提供「打开」与「在文件夹中显示」。打开动作由 `agentWorkspace:openArtifact` 处理：renderer 只传收据 id，主进程按任务授权目录重新 `realpath` 校验，越界、跨任务、已删除的产物一律拒绝，不提供通用文件打开器。

### 失败提示与空流重试（2026-11-19）

- 运行出口统一收敛成中文：`src/main/agent/agent-failure.ts` 的 `describeAgentFailure` 负责分类（超时／鉴权／限流／5xx／空响应／内容审核／上下文超长／网络），`run-loop` 把同一句话写进 `run.error`，`AgentWorkspaceService` 的 send / resume / approve 出口用 `toAgentFailureError` 保证 IPC 抛出的也是这句话。原始技术信息只进 `logWarn`，不进界面。
- 空响应按瞬时故障重试：AI SDK 的 `NoOutputGeneratedError`、`InvalidResponseDataError: Response stream ended without a finish reason` 与我们自己判定的「模型响应为空」都归到 `transient-error.ts`，`completeWithRetries` 自动重发两次，仍失败才暴露给用户。
- `ai-sdk-model.ts` 注册 `streamText` 的 `onError`：SDK 默认把流内 provider 错误吞掉，最终只剩一句「No output generated」；这里先留住真实原因，写进空响应错误的 `agentDetail` 与诊断日志。
- renderer 统一走 `src/renderer/app/views/agent/workspace-error.ts`：剥掉 `Error invoking remote method '…'` 与 `AI_xxxError:` 前缀，纯英文错误退回中文兜底，再按文案给出「下一步」提示。`test/agent/agent-workspace-error.test.ts` 断言 `views/agent` 下不再出现把 `reason.message` 直接塞进界面的写法。
- 错误条改为「警示图标 + 说明 + 下一步 + 关闭」；发送失败后立刻刷新任务详情，用户能看到自己那条消息和「继续运行」入口，不会停在「0 条记录」。

### 这一步之后仍未做的部分

- 只有进程内写锁，还没有跨任务的并发调度器。
- Skill 只有注册与展示，没有启用/停用、版本管理与外部安装。

### 第 4 步已落地的部分：产品只读 Skill

`src/main/agent-runtime/skills/product-readonly/` 通过 `ProductReadPort`（`list` / `get` / `readiness`）暴露 `product.list` 与 `product.status` 两个动作：

- 只注册 `read` 动作，结构上不可能替代程序检查、运营确认或录入授权；`test/agent/product-readonly-skill.test.ts` 直接断言这一点。
- 就绪结论读不到时如实返回"无法读取"，不会默认通过。
- 产品 id 支持唯一前缀，前缀过短或命中多个直接报错，不猜产品。
- 只读动作直接执行并留下审计收据，不进审批。
- 系统提示同时写死：产品门禁只能由运营在产品界面完成，智能体不得替运营宣布"已确认"或"已录入"。

### 第 4 步：决策已定（A，永久只读）

2026-11-17 运营确认选 **A**：通用智能体的 `once`/`thread` 授权**不得**等同于运营确认，产品门禁只能由产品界面上的运营确认动作满足。

这个决定已代码化，而不只是写在文档里：`assertProductActionsReadOnly()` 在装配产品 Skill 时断言所有动作都是 `read`，一旦有人加写/删动作立即抛错；测试同时覆盖"合法只读通过"与"写动作被拒"。

后续若要改成 B（允许发起写入但确认仍归产品界面），需要同时改这道守卫、加产品级前置校验，并重跑 25 项强制回归。

### 第 6 步已落地的部分：演示文稿 Skill

`src/main/agent-runtime/skills/deck/` 新增依赖 `pptxgenjs@^4.0.1`：

- `plan.ts`：模型只能输出受 Zod 约束的结构化大纲（`cover / section / bullets / closing`，限 40 页、每页 8 条要点）；模型侧的 `deckPlanJsonSchema` 与运行时校验同源，字段不允许两面不一致。
- `render.ts`：模板渲染成**可编辑** `.pptx`（16:9、白底、zinc 墨色、teal 强调、页脚页码），只负责生成、不承担预览渲染。
- `index.ts`：`deck.generate` 是 `write` 动作，走同一套目录授权与操作收据；省略 `path` 时按标题命名；同名文件已存在时**旧版先归档到 `.agent-trash` 再写新版**，因此每次生成在磁盘与收据上都留下可回读的版本记录。
- 生成结果经 python-pptx 解析校验：13.33×7.5 英寸、页数与大纲一致、中文与页脚完整。

### 第 7 步：MCP 外部 Skill（协议层已通）

新增依赖 `@modelcontextprotocol/sdk@1.32.2`（官方 TypeScript client）。模块 `src/main/agent-runtime/mcp/`：

- `client.ts`：stdio 连接、列工具、调用工具、连接/调用超时（默认连接 15s、调用 20s）、诊断状态。
- `skill.ts`：把 MCP 工具桥接成内置格式的动作。**只有 server 显式声明 `readOnlyHint: true` 才算只读**，其余一律按写入处理；同一 server 的写动作共用一个账号键，天然串行；调用超时按"可能已执行"抛 `AgentUncertainActionError`，由执行器落成 `uncertain`，禁止盲目重试。
- `source.ts`：多 server 发现、指纹比对（新增/移除/参数变化）、60 秒缓存与 `force` 重连。单个 server 起不来只记诊断，不拖垮内置能力。
- `config.ts`：从设置键 `agentMcpServers`（JSON 数组）解析配置，坏 JSON 整体忽略、单条非法只跳过该条，诊断里可见。
- `src/main/agent-workspace/external-tools.ts`：运行期容器，`send`/`resume` 前刷新，`close()` 释放子进程。

面板新增「外部工具」区块：每个 server 的连接状态、工具列表、错误与 Schema 变化；有 server 不可用时即使没有运行事实也会显示面板。

已验证：真实 stdio 子进程（`test/fixtures/mcp/fixture-server.mjs`）完成发现、调用、超时、Schema 变化、坏服务隔离；外部写工具走**同一条**审批 → 收据路径（审批前外部世界无变化，批准后写入真的落到外部进程并被回读）。

**配置界面**：设置页新增「外部工具（MCP）」卡片（`views/settings/agent-tools-block.tsx`）：列出已配置服务与连接状态、增加/删除/编辑（id、显示名、启动命令、参数、超时）、保存并应用、重新连接。写入边界写死在卡片说明里——只读工具直接可用，写入工具仍要逐次授权，界面不提供任何放宽权限的入口。

配置入口链路：`agentWorkspace:externalTools` / `saveExternalTools` / `refreshExternalTools` → `ExternalToolSettings`（与对话链路共用同一个 `ExternalToolRuntime`，避免两套子进程）→ 设置键 `agentMcpServers`。保存时按 id 合并既有 `env`：界面不编辑 env，但也不会顺手丢掉代码配置里的 env；环境变量不进设置页是为了避免把长期凭据写进 SQLite。

**单服务连接/断开**：每个服务行有「断开 / 连接」按钮（`agentWorkspace:setExternalToolConnection`）。断开后该服务状态标为「已断开」、工具从运行时 Skill 列表移除，其他服务完全不受影响；连接则只重连这一个。

已知代价与缺口：SDK 的 `dependencies` 包含 express / hono 等 HTTP 传输依赖，打包体积会增加，本轮只使用 stdio 子路径、未做裁剪；env 只能直接改设置项；**断开状态只在本次会话内有效**（重启应用会按配置重新连接）。

### 第 5 步的只读部分：VBK 会话状态

`skills/vbk-readonly/` 提供三个只读动作：

- `vbk.status`：当前 VBK 会话是否登录、展示名、登录账号与本机已知账号；
- `vbk.contacts`：当前账号（或指定供应商）下的管家联系人卡片，走已登录页面发起一次只读请求；
- `vbk.poi`：按关键词查平台 POI 候选，返回名称、id、所在地与是否可选（用于行程规划时核对景点）。

- 走 `VbkReadPort` 端口（主进程用现有 `VbkBrowser.status()` 装配），Skill 不直接碰浏览器或页面；
- 默认读缓存，`refresh=true` 才触发页面初始化与当前用户抓取——避免每次对话都把后台页面拉起来；
- 浏览器不可用时如实返回未登录并说明原因，端口读取失败时 Skill 如实报错而不是让运行崩掉；
- 只注册 `read` 动作，不执行任何后台写入；
- `providerId` 省略时先用当前活跃账号的缓存；缓存缺失才用已登录会话**现场探测一次**并把结果写回缓存，探测不到才报错——真实核验里正是这条让查询从"失败"变成"拿到 50 个联系人卡片"；
- 读取失败一律抛出，由执行器记 **failed 收据**，不允许"收据成功、正文说失败"；
- 真实装配在 `agent-workspace/vbk-adapter.ts`：复用现有 `runVbkPageExclusive` 独占执行与 `listProviderContactCards` 只读接口，不新造浏览器逻辑。

### 第 5 步的写入准入（机制已就位，业务动作待定）

后台域写动作有装配期准入守卫 `assertBackendWritesAreVerifiable()`：技能 id 以 `vbk` 开头时，任何非只读动作**必须同时声明 `preview`（让运营看见将发送什么）与 `reconcile`（执行后回读核对）**，否则 `createAgentRuntime` 直接抛错、拒绝装配。缺了这两样，一次超时或半截失败只能记 `failed`，无法判断外部到底有没有发生。

外部 MCP 工具不受这条约束——它们的可核查性由各自 server 负责，不能替它们加无法满足的要求。

### 第 5 步还没做的部分

具体后台**写**动作的实施见 [VBK 写入实施计划](/Users/cisco/Documents/vbk-auto/docs/general-agent-vbk-write-plan.md)（范围已确认，待一处规则确认后开工）；三人同游服务端 adapter 的只读部分已落地，见下方「第 8 步」。写入的准入机制已就位（见上）。

注意决策 A 的连带影响：产品的「行程录入」属于 `行程规划 → 程序检查 → 运营确认 → 行程录入` 的最后一环，通用智能体触发它等于绕过程序检查与运营确认。因此第 5 步可做的后台写，只剩**产品域之外**的操作（例如账号/供应商资料维护），范围需要另定。

写动作本身也需要逐条定义：受 Schema 约束的业务动作、前置状态读取、幂等键、执行后回读核查与 `uncertain` 收敛。三人同游后台还缺接口/会话信息，无法凭空实现。

真实会话核验（2026-11-17，运营已授权真实后台访问）：

- `vbk.status` 从真实 VBK 适配器读到当前会话已登录（小璐 / vbk_671205），并如实说明"读取的是缓存、需要实时状态可强制刷新"；
- 首次 `vbk.contacts` 因 providerId 缓存缺失而失败——**由此发现并修掉两个问题**：一是缓存缺失时没有尝试现场探测（现已补上，探测到会写回缓存），二是读取失败被记成 succeeded 收据（现已改为抛错 → failed 收据）；
- 修复后复验：providerId 从实时会话探测为 1279416，返回该供应商下 **50 个管家联系人卡片**，收据 `vbk.contacts:succeeded`。

`vbk.poi` 真实核验：查「扎什伦布寺」返回 10 个平台候选（主寺 id 76348 及寺内子点位、阿里札达同名寺），收据 `vbk.poi:succeeded`，模型还主动提示"末位 148617014 是同名的另一座寺，别选错"。

全程只读，未触发任何后台写入。

### 第 6 步还没做的部分

附件上传与幻灯片缩略图渲染（PPT 只有生成 + 收据 + 版本归档，没有图形预览）。

### 第 6 步：网页 Skill

`src/main/agent-runtime/skills/web/` 提供 `web.build`：

- `plan.ts`：受 Zod 约束的网页内容计划（标题 / 描述 / 主题 / 小节 + 要点）。
- `render.ts`：确定性渲染 `index.html`、`styles.css`、`README.md`；模型文本一律 HTML 转义后再拼接，模型无法注入标签或脚本。
- `index.ts`：一次调用对应一个目标目录、一次审批、一张收据；目录已存在时**整目录先归档到 `.agent-trash` 再重建**，新旧版本不会混在同一个目录里。
- 产物是纯静态文件，双击 `index.html` 即可在浏览器预览（已用 Playwright 实际渲染截图核对）。

### 第 8 步：三人同游服务端只读（service token）

三人同游服务端（Tibet）的只读接入已落地：`tibet.status` / `tibet.services` / `tibet.adminServices` /
`tibet.service` / `tibet.vbkBindings` / `tibet.orders` / `tibet.order` 七个只读动作，
令牌默认继承创建者管理员并可按类型叠加客户 / 扩展用户身份；令牌存本机 0600 文件，设置页可保存、验证、清除。

细节（令牌与身份契约、代码分层、不变量、验证记录）见
[三人同游服务端接入](/Users/cisco/Documents/vbk-auto/docs/general-agent-tibet-service.md)。
