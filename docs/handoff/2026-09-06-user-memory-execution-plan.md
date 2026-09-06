# 本地记忆系统（版本：5.3）执行文档

日期：2026-09-06
状态：已定稿，进入实施（交给 5.3 执行）

目标：为每个登录用户建立“只写用户明确授权、低成本、定期整理”的本地记忆能力。明确要求记住的内容必须落库；系统在无授权时不主动保存口令/密码等敏感信息；离线和重启后仍可恢复最近会话偏好。

---

## 0. 先验约束（必须遵守）

- 只允许**本地 SQLite**持久化，不做跨设备同步。
- 不能写入/读取跨用户数据；必须以登录用户ID为第一层隔离键。
- 仅接收明确指令的内容进入长期偏好；模糊或临时需求先保留为待确认，不得覆盖长期偏好。
- 不能自动删除显式记忆（explicit）。
- 未登录、用户身份不确定时，不允许写入记忆。
- 任何高风险动作（commit/push/deploy/销毁数据）一律不做。

---

## 1. 任务边界（v1）

1) 核心存储与契约：SQLite 表、IPC 契约、数据库 facade。
2) 显式记忆：识别 `“记住...”` 类口令并确认落库。
3) 检索与上下文注入：Agent / 规划入口按场景读取并注入少量记忆摘要。
4) 自动习惯（轻量）：只做最小“候选+晋升”机制，不做复杂向量化。
5) 周期整理：7 日或待处理条目达到阈值触发维护，不影响读写链路。
6) 单元测试：至少覆盖 parser、数据库/IPC、检索预算。

> 暂不要求：批量 UI 管理页、远端同步、自动训练模型。

---

## 2. 现状扫描（本分支可复用）

当前已有新增文件/改动（建议重用）：
- `src/main/infrastructure/database/parts/memory.ts`（已存在，类型与返回值仍需收口）。
- `src/main/ipc/agent-ipc.ts`、`src/main/ipc/planning-v2-ipc.ts`。
- `src/main/agent/integration-*.ts`（上下文与模型整合有入口）。
- `src/main/infrastructure/database/parts/migration-registry.ts`（存在 0010_agent_snapshots，需继续追加）。
- `src/main/infrastructure/database/database.ts`（VbkDatabase 门面已存在）。
- `src/shared/contracts.ts/contracts-api.ts/contracts-types.ts`（未含 memory 契约）。
- `src/main/infrastructure/ipc-input.ts`、`src/main/preload.cts`（需新增 memory IPC）。

请在修改前先确认未跟踪文件和临时改动不清理。

---

## 3. 数据模型

### 3.1 `user_memories`

- `id TEXT PRIMARY KEY`
- `owner_user_id INTEGER NOT NULL`
- `scope_type TEXT NOT NULL`（`global|account|task`）
- `scope_key TEXT NOT NULL`（如 accountKey 或 localProductId）
- `kind TEXT NOT NULL`（`explicit|inferred`）
- `topic TEXT NOT NULL`
- `preference_key TEXT NULL`
- `content TEXT NOT NULL`
- `conditions_json TEXT NOT NULL DEFAULT '[]'`
- `status TEXT NOT NULL`（`active|inactive|pending|candidate|needs_clarification|archived|superseded`）
- `revision INTEGER NOT NULL DEFAULT 1`
- `superseded_by TEXT NULL`
- `created_at TEXT NOT NULL`
- `updated_at TEXT NOT NULL`
- `last_evidence_at TEXT NULL`
- `last_used_at TEXT NULL`

索引建议：
- `(owner_user_id, scope_type, scope_key, status, updated_at)`
- `(owner_user_id, status, topic)`

### 3.2 `memory_evidence`

- `id TEXT PRIMARY KEY`
- `owner_user_id INTEGER NOT NULL`
- `memory_id TEXT NOT NULL`
- `source_event_id TEXT NULL`
- `task_id TEXT NULL`
- `source_kind TEXT NOT NULL`
- `raw_excerpt TEXT NULL`
- `created_at TEXT NOT NULL`

唯一约束建议：`UNIQUE(owner_user_id, source_event_id, memory_id, source_kind)`（source_event_id 可 NULL 时按事件+kind 做幂等）。

### 3.3 `memory_maintenance_state`

- `owner_user_id INTEGER PRIMARY KEY`
- `auto_capture INTEGER NOT NULL DEFAULT 1`
- `scope_key TEXT NULL`
- `last_task_id TEXT NULL`
- `pending_count INTEGER NOT NULL DEFAULT 0`
- `last_success_at TEXT NULL`
- `updated_at TEXT NOT NULL`

---

## 4. 实施顺序（严格按顺序）

### 第 1 步：共享类型与 IPC 契约

**文件**
- `src/shared/contracts-types.ts`
- `src/shared/contracts-api.ts`
- `src/shared/contracts.ts`

**动作**
- 新增用户记忆类型：`UserMemoryKind`,`UserMemoryScopeType`,`UserMemoryStatus`,`UserMemory`,`UserMemoryInput`,`UserMemoryEvidence`,`MemoryMaintenanceState`,`UserMemoryContext`,`MemoryServiceConfig` 等。
- 在 `VbkApi` 新增 `memory` namespace：
  - `saveExplicit(localProductId, input)`
  - `list(localProductId, filter)`
  - `get(localProductId, id)`
  - `update(localProductId, id, patch)`
  - `disable(localProductId, id)`
  - `delete(localProductId, id)`
  - `maintenance(localProductId)`
  - `settings(localProductId, settings?)`
- `VbkApi` 的参数与返回全部用上述类型。

### 第 2 步：数据库层（持久化）

**文件**
- `src/main/infrastructure/database/parts/memory.ts`（重构/补齐类型匹配）
- `src/main/infrastructure/database/parts/migration-registry.ts`
- `src/main/infrastructure/database/database.ts`

**动作**
- 检查 `memory.ts`：把类型引用改为本共享类型，不再使用不存在别名。
- 增加返回类型统一（`MemoryRecord`->`UserMemory`）和事务边界。
- 增加 migration `0011_user_memories`（建三表与索引）。
- `VbkDatabase` 暴露方法：`saveExplicitMemory / listUserMemories / getUserMemory / updateUserMemory / disableUserMemory / deleteUserMemory / listMemoryEvidence / list/ bumpMaintenanceState / getMaintenanceState`。

### 第 3 步：核心服务与解析器

**新增目录**：`src/main/memory/`

**文件**
- `memory-parser.ts`
- `memory-service.ts`

**动作**
- `memory-parser.ts`：
  - 识别明确记忆动词（如“记住/以后默认/永远不/以后都…”）
  - 负向词与敏感词拦截（“记住密码/验证码/密钥/Token”等直接拒绝显式落库）
  - 输出 `MemoryIntent`（kind/topic/preference/conditions/notes）
- `memory-service.ts`：
  - 注入 `VbkDatabase` + `ownerUserId` 与可选 `scope`。
  - `captureExplicitFromUserMessage`：解析 -> 保存 -> 立即读回。
  - `loadContextMemories`：按 owner/scope/status 排序返回 8 条以内摘要。
  - 预算控制：`maxItems=8`, `maxTokens≈800`（估算 token=字符/2，保守上界）。
  - 维护函数：candidate->active 晋升阈值、过期降级、显式优先。

### 第 4 步：IPC 接入

**文件**
- `src/main/ipc/context.ts`
- `src/main/main.ts`
- `src/main/ipc/memory-ipc.ts`（新增）
- `src/main/infrastructure/ipc-input.ts`
- `src/main/preload.cts`

**动作**
- 在 context 增加 `memoryService?:` 注入。
- `main.ts` 中构建 `MemoryService` 并挂到 context。
- 新建 `memory-ipc.ts`，注册 `memory:*` handler。
- `ipc-input.ts` 加入 `memory` 参数校验。
- preload 增加 `memory` namespace 映射。

### 第 5 步：写入链路接入（显式记忆落库）

**文件**
- `src/main/ipc/agent-ipc.ts`
- `src/main/ipc/product-ai-ipc.ts`
- （如规划链路需）`src/main/ipc/planning-v2-ipc.ts`

**动作**
- `agent-ipc.ts` 在 `agent:send/respond` 入口增加记忆捕获钩子（有 agent run 的消息也记录）
- `product-ai-ipc.ts` 在用户入站对话点位处进行统一 capture（仅在已登录且可解析 owner 时）。
- `AgentContext` 注入 `memoryService` 结果摘要到 `agentTaskContext`；并在 `composePlanningSystemPrompt/composePlanningUserMessage` 注入轻量偏好摘要（不触达任何锁定字段）。

### 第 6 步：维护与定期整理

**文件**
- `src/main/memory/memory-service.ts`（新增方法）
- `src/main/main.ts`（启动时定时任务注册）
- `src/shared/contracts-types.ts`（维护设置类型）

**动作**
- 首次启动后立即执行一次轻量维护。
- 触发策略：按用户 7 天或 pending_count>=30。
- 规则（v1）：
  - explicit 永久保留，只有更新/停用/删除改变。
  - inferred 90 天无新支持 → `candidate`。
  - inferred 180 天无新支持 → `archived`。
  - 自动项总量上限 500，超出删最弱。

### 第 7 步：测试与验收

**新增测试（建议）**
- `test/memory/memory-parser.test.ts`
- `test/memory/memory-service.test.ts`
- `test/memory/database-memory-migration.test.ts`
- `test/infrastructure/ipc-coverage.test.ts`（加 `src/main/ipc/memory-ipc.ts`）

**执行命令**
1. `npm run check`
2. `npm run test -- test/memory`（若测试脚本按子路径不支持，用已有 test runner 的 memory 目录方式）
3. `npm run test -- test/infrastructure/ipc-coverage.test.ts`

---

## 5. 5.3 级验收门（必须逐条通过）

1. **明确记忆可读写**：`“记住以后文案风格克制一些”` 重启后仍可检索。
2. **未登录禁止落库**：未登录路径返回可读提示且不落库。
3. **反误触**：`“记住密码”`、`“这次先说说…”` 不生成长期记录。
4. **临时优先级**：`“这次都用经济型”` 不覆盖长期 `五星酒店`，只有明确长期指令才更新长期。
5. **用户切换隔离**：换账号后读取不到另一个账号条目。
6. **删除一致性**：删除后查询返回空，缓存和待处理维护不可复活。
7. **周期整理安全**：维护失败不影响新写入与检索；重复运行幂等。
8. **性能上界**：检索+注入单次平均不超过 8 条，超过预算必须返回“未注入清单”而不是无响应。

---

## 6. 里程碑交付清单

- 文档更新：本文件与任何新增/修订的类型文档。
- 代码：至少触及 `src/shared/contracts*` / `src/main/memory` / `src/main/infrastructure/database/*` / `src/main/ipc/*` / `src/main/main.ts`。
- 测试：新增 memory 单测 + IPC 覆盖。
- 记录：在最终反馈中给出文件清单、测试输出、失败/未完成项。

