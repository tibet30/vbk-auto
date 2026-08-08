# VBK Desktop 架构总览

> 本文档是仓库架构的**单一入口**。任何"这个项目到底怎么组织的""改动落在哪一层""关键约束是什么"
> 的问题,先翻这里,而不是把 `src/` 全部读一遍。源码注释会说"为什么",本文档说"是什么 / 在哪 / 谁调用谁"。
>
> 维护约定:本文档跟随仓库演进。**新增模块 / 跨模块 IPC / 新增 planner 阶段 / 改变关键 invariants** 时,
> 同步更新对应章节,且提交说明需提及本文档已更新。

---

## 0. 一句话讲清

Electron + React + TypeScript 桌面应用。**用户用自然语言描述一次出行需求,AI 多轮对话帮忙打磨成结构化
旅游产品,再用 Playwright 驱动已登录的 VBK(携程供应商后台)网页,把产品自动写到「保存草稿」为止**。
提审 / 发布必须由人在 VBK 里手动操作 —— 桌面端不触碰。

- AI 模型:`MiniMax` 与 `Evolink(deepseek)` 两套 OpenAI 兼容 API,设置页切换。
- 自动化:Playwright 复用 Electron 内嵌 `WebContentsView`,经 CDP 与持久分区 `persist:vbk` 通信。
- 数据:全部本地 SQLite(`better-sqlite3`),API Key 经 macOS `safeStorage` 加密后落盘。
- 见 [`PRODUCT.md`](./PRODUCT.md) 产品定位,见 [`DESIGN.md`](./DESIGN.md) 视觉与交互规范。

---

## 1. 顶层架构图

```text
                       ┌─────────────────────────────────────┐
                       │          Renderer (React 19)         │
                       │                                     │
   user ── mouse ─────►│  views/  ←── actions/  ←── state/   │
                       │     │              │              │
                       │     └── AppModel (app.main.model)──┤
                       └────────────────┬────────────────────┘
                                        │  window.vbk  (typed)
                                        ▼
                       ┌─────────────────────────────────────┐
                       │ preload.cts (contextBridge)         │
                       │  exposes VbkApi (shared/contracts-  │
                       │  api.ts) as `window.vbk`            │
                       └────────────────┬────────────────────┘
                                        │  ipcMain.handle
                                        ▼
   ┌──────────────────────────── Electron main 进程 ───────────────────────────┐
   │  main.ts (装配层,IPC 注册 + BrowserWindow + 启动恢复)                       │
   │                                                                            │
   │  ┌─ infrastructure/ ── 横切基础设施 ───────────────────────────────────┐   │
   │  │ VbkDatabase(SQLite)│ VbkBrowser(EB WebView+CDP)│ secure-storage    │   │
   │  └────────────────────────────────────────────────────────────────────┘   │
   │                                                                            │
   │  ┌─ data/ ────────── 纯数据归一化(产品 JSON 兼容旧脏数据) ─────────────┐   │
   │                                                                            │
   │  ┌─ minimax/ ─────── AI 服务封装(OpenAI 兼容,provider 无关) ──────────┐   │
   │                                                                            │
   │  ┌─ planning/ ────── 5 阶段多模块规划子系统(★ 新架构核心) ────────────┐   │
   │  │   plan-orchestrator → single-stage-runner → [AI] → validate      │   │
   │  │   adapters/openai-compatible-adapter (唯一持有 provider 细节)    │   │
   │  └────────────────────────────────────────────────────────────────────┘   │
   │                                                                            │
   │  ┌─ operations/ ──── 纯业务操作(product-patch / vehicle / hotel ...) ──┐   │
   │                                                                            │
   │  ┌─ automation/ ───── VBK 浏览器自动化(Playwright over CDP) ─────────┐   │
   │  │   automation.main/* (DraftAutomation 入口)                        │   │
   │  │   ctrip/{basic-info,itinerary,presentation,sale-control,...}      │   │
   │  │   recovery/* (recovery + advisor + 需要用户介入)                  │   │
   │  └────────────────────────────────────────────────────────────────────┘   │
   │                                                                            │
   └────────────────────────────────────────────────────────────────────────────┘
                                  │                                  │
                                  ▼                                  ▼
                       ┌───────────────────────┐         ┌────────────────────────┐
                       │ SQLite (userData)     │         │ VBK (携程供应商后台)      │
                       │ projects / messages  │◄── CDP ─►│ persist:vbk WebContents │
                       │ research_tasks / ... │  (随机)   │                         │
                       └───────────────────────┘ 9300-9899└────────────────────────┘
```

> 进程边界 + 类型共享契约见 §3,主进程模块详解见 §A,渲染层见 §B,端到端数据流见 §D,
> 关键约束见 §C,测试与命令见 §E,技术债见 §F。

---

## 2. 目录结构

```text
src/
  main/                         Electron 主进程
    main.ts                     启动入口 + IPC 注册 + BrowserWindow 装配(已被自己注释为 700+ 行)
    preload.cts                 把 VbkApi 桥接到 window.vbk(contextIsolation)
    data/                       纯数据归一化(product-normalize.ts 启动时校准旧 product JSON)
    infrastructure/             横切基础设施
      database/database.ts      VbkDatabase:SQLite 唯一入口(迁移 / 全部 CRUD)
      vbk-browser.ts            内嵌 WebContentsView + 多账号 session + CDP 复用
      vbk-cookie-serializer.ts  Cookie 序列化(Electron ↔ Playwright 形状对齐)
      secure-storage.ts         API Key 经 macOS safeStorage 加密后落 settings
      ai-settings.ts / ai-models.ts / butler-contacts.ts / current-user.ts
      provider-id-source.ts / db-errors.ts / external-url.ts
    minimax/                    AI 服务封装(目录名沿用,但也服务 Evolink)
      minimax-service.ts        MiniMaxService:三种用途 reply / diagnoseAutomationFailure /
                                disambiguateOption(全部为 OpenAI 兼容 chat.completions)
      minimax-constants.ts      系统 prompt + tool schema + error code
      minimax-parsing.ts        解析模型结构化输出
      minimax-error-handling.ts 错误归类 / reason 提取 / retry hint
    planning/                   ★ 5 阶段多模块规划子系统(provider-neutral)
      plan-orchestrator.ts      顶级:遍历 PLANNING_STAGES 并调用 single-stage-runner
      single-stage-runner.ts    单阶段:调 planner → sanitize → 写入产品
      stage-runner.ts           旧版单阶段(已由上者替代,保留兼容)
      validation.ts / validation-rewind.ts   completeness + 完成态深校验
      schemas.ts                AI_WRITABLE_PATHS(模块→产品 JSON 写入路径白名单)
                                STAGE_ALLOWED_MODULES(每阶段允许的模块)
                                module value schema(zod)
      tool-schema.ts            tool 调用结构(zod)
      state-store.ts / runtime.ts  GenerationStateStore / DbGenerationStateStore
                                 DbOrchestratorRuntime(从持久化产品反推已落地模块)
      orchestrator.ts / types.ts  Planner / OrchestratorRuntime / OrchestratorOptions
      replies.ts                assistant 回复合成(基于实际接受/缺失,**不信模型声明**)
      preflight-failure.ts      preflight 失败包装
      project-status-sync.ts    project.status ← planning 终态(complete→review / failed→blocked)
      research-tasks.ts         research task 规则
      log.ts                    日志
      adapters/openai-compatible-adapter.ts
                                **唯一**持有 baseUrl / model / provider 细节的实现
    operations/                 纯业务逻辑(无 SQL、无 UI)
      product-patch.ts          applyProductPatchSafe(把 AI 输出 patch 安全合并到产品)
      manual-review-field.ts    人工在 UI 录入的少数字段(pricing 等)的白名单合并
      vehicle-resource.ts       resolveVehicleResource:VBK 资源组匹配 + 价格
      hotel-resource.ts         resolveHotelResource:酒店资源匹配
      operation-log-store.ts    自动化操作日志(运行时仍用 in-memory;真实持久化待接)
    automation/                 VBK 浏览器自动化(Playwright over CDP)
      automation.ts / automation.main/    DraftAutomation 入口 + start/stop/retry
      automation.main/automation.main.run.ts / run-one.ts  多阶段 / 单阶段流程
      automation.main/automation.main.class.debug.ts       调试:runStep / snapshot / resume
      automation.main/automation.main.class.helpers.ts     管家解析 / browser bounds 保证
      automation.main/automation.main.context.ts           AutomationRunContext(共享上下文)
      automation.main/automation.main.phases.ts            draftPhasesFor(product):动态阶段顺序
      automation.main/automation.main.errors.ts            AutomationCancelledError
      automation.main/automation.main.ts                   barrel
      automation/browser.ts / constants.ts(URLS) / debug.ts
      automation/phase-retry.ts / dropdown-match.ts / workflow.ts
      automation/recovery/      runPhaseWithRecovery(advisor + 重试 + needs_user)
      automation/schema/        schema.ts / schema-definitions.ts / schema-functions.ts
                                parseProduct / automationBlockers / shouldRefillBasicInfo
      automation/ctrip/         ★ 现场代码:按 VBK 页面拆分
        ctrip.ts(barrel)/basic-info/itinerary/presentation/sale-control
        pricing.ts/package.ts/publish.ts/resources.ts
        tabs.ts/dialogs.ts/screenshot.ts/utils.ts
    renderer/                   React 19 + TypeScript
      main.tsx / App.tsx / assets.d.ts / env.d.ts
      styles/                   tokens.css / reset.css / global.css
      app/
        app.main.tsx            <App />
        app.main.model.ts       useAppModel = state ∘ actions
        brand.ts                APP_NAME 等品牌常量
        state/                  useAppStateBase + useAppStateDerived(localStorage 持久化)
        actions/                useAppActions:所有 IPC 调用封装(actions/*)
        helpers/                constants / 共享组件 / 工具
        views/                  AppView(shell + 路由) + 子视图
          shell/                Rail / Topbar / AccountPopover
          stage-nav/            两步进度导航(review / vbk)
          workspace/            ★ 工作台(主功能,两栏)
            review.*            review 阶段:对话 + 结构化产品摘要
            vbk.*               vbk 阶段:嵌入式浏览器 + 操作面板
          workspace-home/       无项目时的工作台首页
          projects/             项目列表
          settings/             AI / VBK 登录设置
          operation-log/        自动化操作日志页
          account-editor/       账号固定信息编辑弹窗
          notice/               全局提示条
  shared/                       主进程 + renderer 共享(任何一端改类型,另一端编译失败 → 契约强制对齐)
    contracts.ts                barrel
    contracts-types.ts          实体类型:ProjectDetail / AutomationRun / ResearchTask /
                                Settings / OperationLogEntry / VbkLoginStatus ...
    contracts-api.ts           VbkApi:renderer 可见的 IPC 接口面(强类型)
    contracts-planning.ts      PLANNING_STAGES / PlanningModule / PlanningGenerationState /
                                Planner(规划子系统所有契约,provider-neutral)
    ai-provider-config.ts      Minimax / Evolink(deepseek)配置与标签
    hotel-tiers.ts             酒店档次枚举

test/                           通过 `tsx --test test/**/*.test.ts` 跑
  automation/  basic-info-fixes/  infrastructure/  minimax/
  planning/   products/  recommendation-reasons/  resources/
  settings/   workflow/

scripts/                        调试入口与工具脚本
  pi-itinerary.sh               `npm run pi:itinerary -- <projectId> [cdpPort]`,调 debug-step fillItineraryDraft
  debug-step.mjs / autonomous-runner.mjs

examples/                       参考结构化产品 JSON(taiyuan-private-2d1n.json, shanxi-4d3n.json)
fixtures/                       离线测试资源(station-picker.html)
docs/                           历史归档(handoff = 会话临时记录;superpowers/specs & plans = 旧规划)
dist/   dist-electron/          **编译产物,只读**
```

---

## 3. 进程边界与共享契约

| 进程/层          | 文件                              | 职责                                                                                                              |
| ---------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Renderer         | `src/renderer/**`                 | React UI、视图路由、本地状态、localStorage 持久化(`view`、`activeProjectId`)                                        |
| 桥接层           | `src/main/preload.cts`            | `contextIsolation: true` 前提下的 IPC 桥接;**唯一**导出 `window.vbk`(类型为 `VbkApi`)                              |
| 主进程           | `src/main/**`                     | 数据 / 浏览器 / IPC handler / 自动化 / AI 调用 / 持久化                                                            |
| 共享契约         | `src/shared/contracts*.ts`        | 主进程与 renderer 共享的类型 / IPC 接口;**改这里会同时让两端编译失败**,强制对齐                                    |

> 关键约束:`contracts-planning.ts` 是 **provider-neutral** 的。任何 prompt / schema / validator
> / retry 策略都不能出现 `MiniMax` / `Evolink` / baseUrl 字样 —— 这些只能出现在
> `planning/adapters/openai-compatible-adapter.ts` 里。

---

## 4. 共享契约一览(`src/shared/`)

- **`contracts-types.ts`** —— 实体类型。
  - 项目:`ProjectSummary` / `ProjectDetail`(含 `product`、`messages`、`researchTasks`、`automation`、`basicInfoSaved`)
  - 会话:`ConversationMessage`
  - 自动录入:`AutomationRun` / `PhaseRecovery` / `PhaseAttempt` / `RecoveryState` / `AdvisorAction` / `DisambiguateRequest`
  - 设置 / AI:`Settings` / `ConnectionTest` / `AiProvider` / `AiRegenerateField` / `AiResponse`
  - 资源:`VehicleResourceMatch` / `HotelResourceMatch` / `VbkLoginStatus` / `SavedLoginAccount` / `LoginAccountsSnapshot`
  - 账号:`AccountFixedInfo` / `AccountFixedInfoField` / `ProviderContactCard`
  - 操作日志:`OperationLogEntry` / `OperationLogPage` / `OperationType` / `OperationStatus`

- **`contracts-api.ts` —— `VbkApi`**: renderer 可见的全部 IPC,强类型。**新增 / 改 IPC 必须三处同步**:`main.ts` 的 `ipcMain.handle`、`preload.cts`、`VbkApi`。
  分组:`projects` / `ai` / `research` / `browser` / `automation` / `debug` / `accounts` / `contacts` / `settings` / `events`(项目变更推送)/ `operationLog` / `planning`。

- **`contracts-planning.ts`** —— 规划子系统契约:
  - 阶段:`PlanningStage = "skeleton" | "itinerary" | "presentation" | "commercial" | "research" | "validation"`;`PLANNING_STAGES` 顺序
  - 模块白名单:`PlanningModule`(presentation / itinerary / packageName / pricing / inventory / terms / release / researchTasks / skeleton)
  - 输出形态:`PlanningStageOutput`(reply + modules)、`ModuleOutcome`、`PlannerError`(统一错误码)
  - 持久化:`PlanningGenerationState`(`planning_generation` 表,project_id 单行,用于续跑)
  - 接口:`Planner.generateStage(request) → PlanningStageOutput`

- **`ai-provider-config.ts`** —— `aiProviderConfig(settings, provider)` / `aiProviderLabel` / `isAiProvider`。
- **`hotel-tiers.ts`** —— 酒店档次枚举与默认值。

---

## §A. 主进程模块详解

### §A.1 `main.ts` —— 装配层

`app.whenReady()` 内的固定顺序(见 `src/main/main.ts`):

1. `db = new VbkDatabase(app.getPath("userData"))` → `db.recoverUnansweredMessages()` + `db.recoverOrphanAutomationRuns()` + `db.recoverOrphanPlanningStates()`(崩溃态恢复)
2. `registerIpc()` —— 注册全部 `ipcMain.handle`(分文件同名:`projects:* / ai:* / research:* / browser:* / automation:* / accounts:* / contacts:* / settings:* / planning:* / operationLog:load`)
3. `createWindow()` —— `BrowserWindow` + 唯一 `WebContentsView`(`persist:vbk` 分区) + `VbkBrowser.initialise()` + `DraftAutomation` 实例
4. 事件:`project:updated` 主动推送 → renderer 订阅更新本地 project
5. 进程退出前 `browser.dispose()`(关掉复用 CDP 连接)

> ⚠️ `main.ts` 已自我标注 700+ 行,本身就是 §C"约束"中"单文件 ≤ 350 行"的最明显反例 —— 拆分计划见 §F。

### §A.2 `infrastructure/` —— 横切基础设施

| 模块                              | 关键职责                                                                                          |
| --------------------------------- | ------------------------------------------------------------------------------------------------- |
| `database/database.ts`            | `VbkDatabase` 类:SQLite WAL;启动 `migrate()` 建表 + `normaliseStoredProducts()` 把旧 product JSON 用当前规则重新归一 |
| `database/fixed-info.ts`          | 账号固定信息读写(settings 表里以 `accountFixedInfo:<name>` 为 key)                                |
| `vbk-browser.ts`                  | `VbkBrowser`:内嵌 `WebContentsView`、随机取 9300-9899 之间的回环 CDP 端口、多账号登录态、菜单误识别白名单(`MENU_FALSE_POSITIVES`)、CDP 连接复用 |
| `vbk-cookie-serializer.ts`        | Electron 与 Playwright 间 cookie 形状对齐(sameSite / expiry / domain)                              |
| `secure-storage.ts`               | `safeStorage.encryptString` + settings;`isAsyncEncryptionAvailable` / `persistApiKeyAsync` / `loadApiKeyAsync` |
| `ai-settings.ts`                  | `assertSafeAiServiceUrl`(防止 SSRF 到内网 / 本机 / 私网段) / `resolveAiConnectionInput` / `successfulAiConnectionTest` |
| `ai-models.ts`                    | `fetchAiModelList`(远端 `/v1/models`)                                                              |
| `butler-contacts.ts`              | `listProviderContactCards`(VBK 接口拉联系人卡)                                                     |
| `current-user.ts`                 | 从 VBK `getCurrentUserInfo` 接口抓真实账号(优先于 DOM 选择器)                                     |
| `provider-id-source.ts`           | 从 VBK 已登录页面抓 `providerId`(缓存到 `settings:providerIdByAccount:<name>`)                    |
| `external-url.ts` / `db-errors.ts`| `openExternalUrl` / `projectNotFound` 等错误                                                       |

### §A.3 `minimax/` —— AI 服务封装

> 文件夹名沿用历史(项目早期只有一个 provider),但实际同时服务 `MiniMax` 和 `Evolink(deepseek 标签)`
> —— **由 `provider` 字段切标识**。改 provider 不需要改 minimax/* 文件路径。

- `MiniMaxService.config = { apiKey, baseUrl, model, provider }`
  (`provider === "deepseek"` → `isDeepSeek`,展示名变 Evolink)
- 三种用途(都是 `chat.completions` + tool/JSON 输出 + 60~90s timeout):
  - `reply(input)` —— 多轮规划对话,返回 `AiResponse { reply, patch?, questions?, researchTasks? }`
  - `diagnoseAutomationFailure(req)` —— 自动录入失败时调,产出 `AdvisorOutcome` 控制 retry 策略
  - `disambiguateOption(req)` —— VBK 下拉里选不到精确项时,把候选列表交给 AI 选
- `MiniMaxServiceError`:统一错误码 + 消息;**所有错误先过 `minimax-error-handling.ts`** 归类
  (`provider_connection` / `provider_timeout` / `provider_rate_limit` / `provider_authentication` / `invalid_model_output` / `empty_model_output`)
- `minimax-parsing.ts` 解析模型原始输出为 `AiResponse` / `AdvisorOutcome` / `DisambiguateOutcome`

### §A.4 `planning/` —— ★ 5 阶段多模块规划子系统

**这是新架构的核心:把"AI 一次性 chat"升级成"分阶段、可续跑、可验收的流水线"。** 与老路径
(`ai:send` 走 `MiniMaxService.reply` 直接对话)**并存**,由 `main.ts` 接入两个入口:
`ai:send` 与 `planning:start / resume / state`。

**数据流**

```text
  planning:start / resume
        │
        ▼
  plan-orchestrator.runPlan
        │
        ▼  for each stage ∈ PLANNING_STAGES:
        ▼  ┌─────────────────────────────────────────────────────────┐
        ▼  │ single-stage-runner.runSingleStage                      │
        ▼  │   1) runtime.loadAccepted / loadExistingResearchTasks   │
        ▼  │   2) planner.generateStage({ stage, context })         │   ←─ adapters/openai-compatible-adapter
        ▼  │   3) 校验 modules:STAGE_ALLOWED_MODULES 白名单 +       │
        ▼  │      zod value schema + BLACKLISTED_VALUE_KEYS 黑名单  │
        ▼  │   4) writeModule(projectId, module, writePath, value)  │
        ▼  │       ← AI_WRITABLE_PATHS 给出 module → 产品 JSON 固定路径 │
        ▼  │   5) upsertStageInState → store.save                   │
        ▼  └─────────────────────────────────────────────────────────┘
        ▼
  validation.validateCompleteness(acceptedModules)
        │
        ▼
  orchestration.status ∈ { completed, needs_user, failed }
        │
        ▼
  project-status-sync.syncProjectStatusAfterRunPlan
        │   (completed→review / needs_user|failed→blocked)
        ▼
  emitProject + addMessage(assistant)
```

**关键不变量**(从 `schemas.ts` / `stage-runner.ts` 注释提取):

- **模块白名单**:`PlanningModule` 是 AI 能写的全部路径;`AI_WRITABLE_PATHS[module] → 产品 JSON 子树路径`
  (如 `packageName → commercial.packageName`)
- **阶段模块白名单**:`STAGE_ALLOWED_MODULES[stage]` 限定该阶段允许产出的模块
  (防止 itinerary 阶段写 release)
- **AI 禁写键**:`supplierProductCode` / `vehicleResource` / `hotelResource` / `contactCardId` /
  `providerId` / `supplierCode` / `vehicleId` / `resourceId` / `resourceGroupId` / `butler` /
  `bookingControls`(运营数据,AI 看见就拒)
- **`release` 模块被强制 draft-only**:`{ ...value, submitReview: false, publishAfterApproval: false }`
  (即便模型说"提审",也会被本层覆盖)
- **completed → 续跑也 deep-validate**:`validation-rewind.ts` 防止"浅判断通过 / 深校验失败"
  的脏数据被永久 accepted

**接口边界(provider-neutral)**

- `Planner` / `PlannerContext` / `PlannerRequest`(见 `types.ts`)—— orchestrator 只看到接口
- `OpenAICompatiblePlannerAdapter`(见 `adapters/openai-compatible-adapter.ts`)—— 唯一允许出现
  `baseUrl` / `model` / `apiKey`
- `DbGenerationStateStore` / `DbOrchestratorRuntime`(见 `runtime.ts`)—— 把接口绑到现有 `VbkDatabase`

**为什么需要 `runtime.loadAcceptedModules(projectId)`(而不是 in-memory accumulator)?**
进程崩溃后 in-memory state 全丢,续跑必须从持久化产品 JSON 反推"哪些模块已落地" —— 这是状态的
**"真"** 唯一来源。

### §A.5 `automation/` —— VBK 浏览器自动化

- `automation.main.class.ts` ── `DraftAutomation` 入口:`start(projectId)` / `stop` / `retry` /
  `retryPhase` / `retryOnePhase` / 全部调试入口
  - `running: Set<string>` 防同项目并发;`cancellationRequested: Set<string>` 取消信号
  - `stop()` 立刻把 `run.status` 改为 `cancelled` + UI 同步;**不强制 abort in-flight Playwright 调用**
    (跨进程 await click 无安全中断点,让 handler 自然结束后下一 checkpoint 跳出)
- `automation.main.run.ts` ── `runAutomation(ctx, projectId, retryFrom?)` 主循环,按
  `draftPhasesFor(product)` 跑各阶段
- `automation.main.run-one.ts` ── `runOnePhase`:单阶段重跑
- `automation.main.phases.ts` ── `draftPhasesFor(product)`:动态阶段顺序(basic → presentation →
  itinerary → package → [pricingInventory] → [hotelResource] → [vehicleResource] → [terms] → preflight)
- `automation.main.class.debug.ts` ── `debugRunStep(stepName, argsJson)` / `debugSnapshot(label)` /
  `debugResume(continue|step|stop)` —— 启用方式:`VBK_DEBUG=1`
- `automation.recovery/` ── `runPhaseWithRecovery`:失败后调 advisor → 重试 / reload / 弹给用户
  (`needs_user`)
- `automation.ctrip/` ── 现场代码,**按 VBK 页面分区**而不是按对象
  - `basic-info/` supplier / supplierProductCode / productName
  - `itinerary/` 每日描述 / 车站 / 卡片
  - `presentation/` 推荐理由(3 条互不重复) / features / cover
  - `sale-control/` 库存 / 售卖 / bookingControls
  - `pricing.ts` / `package.ts` / `publish.ts` / `resources.ts` / `tabs.ts` / `dialogs.ts` /
    `screenshot.ts` / `utils.ts`
- `automation.schema/` ── `parseProduct` / `automationBlockers` / `shouldRefillBasicInfo`
  (与 `data/product-normalize.ts` 配套)

### §A.6 `operations/` —— 纯业务操作

无 SQL、无 UI,只做组合逻辑:

- `product-patch.ts` ── `applyProductPatchSafe`:把 AI 返回的 RFC6902 patch 合并到产品,
  **所有 patch 必须走产品 schema 校验才落库**
- `manual-review-field.ts` ── `applyManualReviewField`:人工在 UI 录入的少数字段(目前仅 `pricing`),
  独立白名单路径,不走 patch
- `vehicle-resource.ts` / `hotel-resource.ts` ── VBK 资源组 / 酒店资源匹配
- `operation-log-store.ts` ── 自动化操作日志(目前为运行时内存样例;接持久化文件后再切)

---

## §B. 渲染层(`src/renderer/`)

### §B.1 分层

```text
main.tsx
  └── <App /> (app/app.main.tsx)
        └── <AppView /> (app/views/AppView.tsx) ←── shell + 路由
              ├── <AppRail />          ← 56px 全局导航
              ├── <AppTopbar />        ← 44px 顶栏(项目 / VBK 登录态 / 保存草稿)
              ├── <AppStageNav />      ← review / vbk 两步进度
              └── <ActiveRoute />      ←── 按 model.view 路由
                    ├── workspace       → <AppWorkspaceWorkflow>
                    │                   ├── stage="review" → <AppWorkspaceReview> [AI 对话 + 结构化产品摘要]
                    │                   └── stage="vbk"    → <AppWorkspaceVbk>    [内嵌浏览器 + 操作面板]
                    ├── projects        → <AppProjectsPage>
                    ├── settings        → <AppSettingsPage>
                    └── operation-log   → <AppOperationLogPage>
```

### §B.2 状态 / 编排 / 视图

| 路径                                   | 职责                                                                                                   |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `app/state/base.ts`                    | `useAppStateBase`:所有原始 state(view / project / activeProjectId / settings / readiness / input...)  |
| `app/state/derived.ts`                 | `useAppStateDerived`:派生(`reviewStepStatus` / `vbkStageStatus` / `splitStyle` / 自动项目列表置顶等)    |
| `app/state/auto-start-policy.ts`       | 何时触发首次 AI 规划的策略                                                                             |
| `app/state/project-list-helper.ts`     | 项目列表操作(置顶 / 顺序)                                                                            |
| `app/actions/account.ts`               | 账号固定信息(读 / 写)                                                                                 |
| `app/actions/minimax.ts`               | AI 设置 + 模型列表 + 连接测试                                                                          |
| `app/actions/project.ts`               | 项目 CRUD / 字段更新                                                                                   |
| `app/actions/workflow.ts`              | 汇总 workspace 全部 action(核查 / 自动化 / VBK 浏览器 / 多账号登录 / 路由)                             |
| `app/actions/useAppActions.ts`         | `useAppActions(state)` = 上述 actions 组合                                                             |
| `app/app.main.model.ts`                | `useAppModel = useAppState + useAppActions`                                                            |
| `app/helpers/`                         | 常量 / 共享组件 / 渲染层工具(`initialInput` / `emptyReadiness` / `phaseDisplayLabel` 等)               |

### §B.3 关键派生状态

- `reviewStepStatus` / `vbkStageStatus`(`derived.ts` 中 `statusState` 派生)
- `planningRecovery`:从 `project` 抽出最近一次 `PlanningGenerationState`,用作"上一轮跑的是哪个阶段,失败原因"
- `browserRef` / `conversationRef` 等 DOM ref 透传

### §B.4 持久化

仅两条 `localStorage` 键:

- `vbk:view`(`workspace` / `projects` / `settings` / `operation-log`)
- `vbk:activeProjectId`(最近打开项目的 id;**注意刷新后是从主进程拉权威 ProjectDetail 恢复**,
  而不是把整个对象塞 localStorage)

---

## §C. 关键架构约束(invariants)

> 任何 PR 触碰以下点,Code Review 必须显式确认未破坏。

1. **AI 禁写字段**(`stage-runner.ts` `BLACKLISTED_VALUE_KEYS`):
   `supplierProductCode` / `vehicleResource` / `hotelResource` / `contactCardId` / `providerId` /
   `supplierCode` / `vehicleId` / `resourceId` / `resourceGroupId` / `butler` / `bookingControls`。
   一旦出现在模型输出 value 中,整模块被 reject。

2. **`release` 模块 draft-only**:`{ submitReview: false, publishAfterApproval: false }` 强制覆盖,
   即便模型要求提审或发布。产品规范红线:**桌面端不触碰提审 / 发布**。

3. **多账号登录会话**:同屏只展示一个账号;切换 / 新增登录前 `saveCurrentSession` 把当前 cookies
   抽到 `login_sessions` 表,`switchAccount` 时 `cookies.set` + `flushStore`。

4. **Provider 抽象**:prompt / schema / validator / orchestrator / runtime 都不允许出现
   `MiniMax` / `Evolink` / baseUrl 字样。仅 `planning/adapters/openai-compatible-adapter.ts`
   允许持有 `baseUrl` / `model` / `apiKey`。

5. **Electron 安全**:`contextIsolation: true` / `nodeIntegration: false` / `sandbox: true` /
   preload 桥接。**禁止**在 renderer 直接 `require('electron')`。

6. **CDP 端口**:启动时随机取 9300~9899,且只听回环地址(`127.0.0.1`)—— 防 9222 等固定端口
   被预测或抢占。

7. **safeStorage**:API Key 经 `safeStorage.encryptString` 后才落 `settings`;若
   `isAsyncEncryptionAvailable()` 返回 false,`settings:save` 直接拒绝并提示。

8. **AI 服务 URL 安全**:`ai-settings.assertSafeAiServiceUrl` 阻止内网 / 本机 / 私网段地址
   (防止 SSRF 到本机或内网服务)。

9. **代码体量**(源码文件):每个文件默认 ≤ 350 行(±50)。`main.ts`(700+) / `minimax-service.ts` /
   `minimax-constants.ts` / `minimax-parsing.ts` / `schemas.ts` / `automation.main.run.ts`
   是当前已知最大文件;**任何新增跨文件改动都应顺手把超额文件拆分**。**本文档不受此限制**(维护者保留单文件可读性)。

10. **Automation 取消语义**:`stop()` 不强制 abort in-flight Playwright 调用;
    `cancellationRequested` 在阶段间与 attempt 间被轮询,handler 自然结束后下一 checkpoint
    跳出。`run.status` 走 `cancelled`、project.status 走 `blocked`(区分于 `failed`,
    UI 显示"已停止")。

11. **状态恢复**:启动时三件事:
    - `db.recoverUnansweredMessages()`(上一轮 user-running 但没有 assistant 回复 → 标 failed)
    - `db.recoverOrphanAutomationRuns()`(运行中 run → failed,recovery phases 推到 needs_user)
    - `db.recoverOrphanPlanningStates()`(running planning → needs_user)
    避免 UI 永远卡在"正在录入"/"正在规划"。

12. **Pluggable 子系统隔离**:`minimax/` 与 `planning/` 之间通过 `Planner` 接口连接;
    `automation/` 不直接 import minimax;`data/` 与具体业务模块解耦。

---

## §D. 端到端数据流(三条主线)

### §D.1 经典多轮对话:用户 → AI → 产品 JSON

```text
useAppActions.send(projectId, text)
  └── IPC ai:send
        └── main.runAiReply
              ├── db.addMessage(role=user, taskStatus=running)
              ├── service.testConnection()(失败则提示填写 API Key)
              │     └── MiniMaxService.testConnection
              │           └── openai.chat.completions.create({ max_completion_tokens: 1 })
              ├── service.reply({ message, product, history })
              │     └── chat.completions.create with tool schema
              │           → parsing.parseAssistantMessage → AiResponse { reply, patch?, questions?, researchTasks? }
              ├── applyProductPatchSafe(currentProduct, patch)
              │     └── operations/product-patch.ts(每个 op 都过产品 schema;失败拒收)
              ├── db.updateProduct(projectId, next) + db.updateMessageStatus(succeeded)
              ├── db.addMessage(role=assistant, reply, succeeded)
              ├── addResearchTask(projectId, task)  // 任一 task
              └── emitProject(currentProject)  // 推 project:updated
renderer 订阅 events.onProjectUpdated → state.setProject(detail)
  → 自动新绘结构化产品摘要 + 对话流
```

### §D.2 规划子系统:骨架 → 5 阶段流水线

```text
useAppActions.planning.start(projectId)
  └── IPC planning:start
        └── main.runPlanning
              ├── restoreProjectToPlanningForRetry(若 blocked)
              ├── savePlanningState({ status: pending, currentStage: skeleton })
              ├── adapter = OpenAICompatiblePlannerAdapter({ apiKey, baseUrl, model })
              ├── store = new DbGenerationStateStore(db); runtime = new DbOrchestratorRuntime(db)
              └── runPlan({ projectId, skeleton, store, runtime, planner })
                    ├── 循环 for stage ∈ PLANNING_STAGES:
                    │     ├── runSingleStage
                    │     │     ├── runtime.loadAccepted / loadExistingResearchTasks / loadCurrentProduct
                    │     │     ├── adapter.generateStage → PlanningStageOutput
                    │     │     ├── validation by schemas + BLACKLISTED_VALUE_KEYS + STAGE_ALLOWED_MODULES
                    │     │     ├── writeModule(productId, module, AI_WRITABLE_PATHS[module], value)
                    │     │     │     └── runtime.writeModule → applyProductPatchSafe → db.updateProduct
                    │     │     └── store.save(state)
                    │     └── state.completedStages.push(stage)
                    ├── validateCompleteness(acceptedModules)
                    ├── syncProjectStatusAfterRunPlan(db, projectId, status)
                    └── db.addMessage(role=assistant, reply, succeeded|failed)
```

### §D.3 自动录入:产品 → VBK 草稿

```text
useAppActions.startAutomation(projectId)
  └── IPC automation:start
        └── DraftAutomation.start
              └── runAutomation(ctx, projectId)
                    ├── ctx.browser.setVisible(true) + ensureBrowserHasBounds(兜底)
                    ├── automationBlockers(project.product)        // 阻断必填字段
                    ├── draftPhasesFor(product)                    // 动态阶段序列
                    └── for phase of draftPhases:
                          └── runPhaseWithRecovery
                                ├── 该阶段函数(automation/ctrip/<phase>/*.ts)
                                │     └── page = VbkBrowser.page()(CDP 复用)
                                │     └── 页面操作 → 截图 → 校验 → 写入
                                ├── onFail → advisor(req) 决定 retry / reload / needs_user
                                └── emitProject(currentProject)

桌面端**不**触发 publish.ts 中的"提审 / 发布"路径;
publish.ts 中相关函数被保留,但调用方在 phase 序列最后只跑到 "保存草稿"。
```

---

## §E. IPC 装配矩阵

> 改 IPC = 改 `VbkApi`(types) + `main.ts`(handler) + `preload.cts`(桥) + 调用方(renderer state/action)
> **四处必须同步**,否则 typecheck 失败。

| 分组                                 | channel                                                                                        | 落点                                                                                                |
| ------------------------------------ | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `projects:*`                         | list/create/get/delete/readiness/updateReviewField/updateProductJson                           | `VbkDatabase` CRUD                                                                                  |
| `ai:send`                            | runAiReply                                                                                     | `MiniMaxService.reply` → `applyProductPatchSafe` → `db.updateProduct`                              |
| `research:*`                         | accept / resolveVehicleResource / resolveHotelResource / preview…                              | `db.markResearchAccepted` / `resolveVehicleResource` / `resolveHotelResource`                       |
| `browser:*`                          | login / logout / status / navigate / currentUrl / openExternal / ...                           | `VbkBrowser`                                                                                        |
| `automation:*`                       | start / stop / retry / retryPhase / retryOnePhase / debug:*                                    | `DraftAutomation`                                                                                   |
| `accounts:*`                         | getFixedInfo / saveFixedInfo / fixedInfoSchema / detectProviderId / ...                        | `db.getAccountFixedInfo` / `db.setAccountFixedInfo` / `detectProviderIdFromBrowser`                 |
| `contacts:listProviderContactCards` | listProviderContactCards                                                                       | `butler-contacts.listProviderContactCards`                                                          |
| `settings:*`                         | get / getApiKey / listModels / save / test                                                     | `ai-settings` / `ai-models` / `secure-storage`                                                      |
| `planning:*`                         | start / resume / state                                                                         | `runPlanning` → `runPlan`                                                                           |
| `operationLog:load`                  | load(query?)                                                                                   | `operation-log-store.loadOperationLog`                                                              |
| `project:updated`                    | 事件(单向)                                                                                    | 任何 `db.updateXxx` 之后调用 `emitProject(project)`(定义在 `main.ts` 闭包中)                       |

---

## §F. 测试 / 开发命令 / 技术债

### §F.1 命令

```text
npm install              # 一次性
npm run dev              # vite 5173 + tsc -w + electron(自动等 main 编译完成)
npm run build            # vite build + tsc
npm start                # build + electron
npm run package          # 打 macOS DMG
npm test                 # tsx --test test/**/*.test.ts
npm run check            # tsc --noEmit + tsc -p tsconfig.renderer.json(两套类型同时检查)
npm run pi:itinerary -- <projectId> [cdpPort]   # CLI 调 debug-step.mjs fillItineraryDraft
```

> VBK 调试需要在 Electron 设置环境变量 `VBK_DEBUG=1`
> (`automation.main.class.debug.ts` 的断点机制才生效)。

### §F.2 已知技术债与拆分候选

仅列**架构层面**事项(具体 issue 现场由 Code Review / planning 文档承载):

- **`main.ts` 拆分**:700+ 行,IPC 注册 + 装配 + 启动恢复混在一起;候选拆分:
  `boot/recovery.ts`、`boot/ipc-projects.ts`、`boot/ipc-ai.ts`、`boot/ipc-planning.ts`、
  `boot/ipc-browser.ts`、`boot/ipc-accounts.ts`、`boot/ipc-settings.ts`、`boot/window.ts`。
- **`minimax-service.ts` / `minimax-constants.ts` 拆分**:模型 prompt + tool schema + 错误码
  挤在一个文件;按用途拆为 `minimax/reply.ts`、`minimax/diagnose.ts`、`minimax/disambiguate.ts`
  (各自独立 prompt + tool + 测试)。
- **`automation.main.run.ts` 拆分**:同文件已自我注明 `automation.main.run-one.ts` 已抽离;
  若继续吃进新阶段,应按阶段类型再拆。
- **`renderer/state/derived.ts` 拆分**:400+ 行;按派生族拆为
  `derived-readiness.ts`、`derived-planning.ts`、`derived-browser.ts`。
- **操作日志持久化**:`operation-log-store.ts` 当前用 in-memory 样例;下一步接入 JSONL 文件 +
  限额滚动。

---

## §G. 进一步阅读

| 文件                                                            | 何时去读                                                              |
| --------------------------------------------------------------- | --------------------------------------------------------------------- |
| [`README.md`](./README.md)                                      | 项目名 / 工作流 / 常用命令                                             |
| [`PRODUCT.md`](./PRODUCT.md)                                    | 任何"为什么这样做"的产品问题(品牌承诺 / 能力边界 / 提审仍人工的红线) |
| [`DESIGN.md`](./DESIGN.md)                                      | 视觉、交互(density、动效、shadcn 参考)                                |
| [`AGENTS.md`](./AGENTS.md)                                      | AI 协作规范:Codex 规划 / Pi 实现 / Claude 审查;代码 ≤ 350 行           |
| [`CLAUDE.md`](./CLAUDE.md)                                      | Claude 视角的执行模式 + 不可逆操作清单                                 |
| `src/main/main.ts`                                              | IPC 装配、启动顺序;所有 channel 一站式定位                            |
| `src/shared/contracts-api.ts`                                   | 改 IPC 时先看这里                                                     |
| `src/shared/contracts-planning.ts`                              | 改规划子系统时先看这里                                                |
| `src/main/planning/plan-orchestrator.ts`                        | 了解分阶段流水线如何推进                                              |
| `src/main/automation/automation.main/automation.main.class.ts`   | 了解 DraftAutomation 的入口与取消语义                                 |
| `docs/handoff/*.md`                                             | 历次会话的临时上下文压缩,非长期架构文档                               |
| `docs/superpowers/specs / plans`                                | 历史规划文档                                                          |
