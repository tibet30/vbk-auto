---
title: 产品审查 + VBK 录入问题修复
status: approved
date: 2026-08-03
---

# 产品审查 + VBK 录入问题修复

## Context

近期运营反馈集中指向两件事：

1. **审查 → 录入流程之间存在可见性差距**：审查阶段 (`stage=review`) 只显示前 4
   条 readiness issues，多于 4 条时直接被裁掉；运营看不到完整清单，也不知道「还有 N 项」。
2. **录入阶段的失败提示对运营不友好**：
   - 同一阶段连续失败 3 次后，UI 只显示最后一次的诊断；老一轮的诊断记录会被覆盖丢失。
   - recovery 的 `productIdExists` 闭包值偶尔 stale，导致 advisor 误判 `reopen_editor_and_retry_phase`。
   - AI 可以写入 `/commercial/pricing` / `/commercial/inventory` / `/commercial/release`
     让产品进入可录入状态，但 `outputGuide` 没显式列出，模型偶发遗漏。
   - 「保存并写入」成功后没有视觉反馈，运营不知道刚才点的是哪一条。
   - 「切换登录」会把当前项目拍掉，运营必须重新点回项目才能继续审查。
3. **可观察性问题**：应用重启时 `automation.status=running` 的孤儿 run 永远停留在
   「正在录入」；UI 永远不显示停止的诊断。

## Approach

按四批修复：

- **D**：recovery attempts 归档 + advisor 决策使用最新 `productIdExists` + AI outputGuide 补 commercial 字段
- **E**：UI 显示完整 issues / confirm 高亮 / openLogin 保留项目 / watcher 文档
- **F**：7 套新增测试覆盖数据库 / providerId 缓存 / IPC 同步 / 录入 JSON / scheduler
- **G**：本文档（设计 + IPC 边界 + recovery 状态机）

---

## 1 · Recovery 状态机

`PhaseRecovery.state` 有 5 个合法值；转换图如下（实线 = runner 内部跳转，
虚线 = 外部事件触发）。

```
                  ┌──────────────────────────────────┐
                  │                                  │
                  ▼                                  │
   ┌─────────┐   attempt 1..3  ┌───────────┐  attempt 3  ┌────────────┐
   │ running │ ──────────────► │ advising  │ ─────────► │  failed    │
   │         │ ◄────────────── │           │            │  (再 attempt) │
   └─────────┘   applyAction   └───────────┘            └────────────┘
        │ 失败                                                      │
        │                                                          │
        │ wait_for_user        advisor outcome ∈ 白名单              │
        │                                                          │
        ▼ 顾问结果 = wait_for_user                  ──────────────┐
   ┌────────────┐                                  ▼           │
   │ needs_user │ ◄────────────────────────────  max attempts ──┘
   └────────────┘  (attempt=3 仍未成功)
        │
        │ 第二次进入 phase（runner 重试 / UI 「重新开始一轮」）
        ▼
   ┌─────────┐  archive attempts → attemptsHistory
   │ running │  rec.attempts = []                      
   │ (新轮)   │  attemptsHistory 保留上一轮的诊断
   └─────────┘
```

### 状态语义

| state | 含义 | UI 表现 | 退出条件 |
| --- | --- | --- | --- |
| `running` | handler 正在执行 | spinner；step 2 phase 标 running | handler 抛错 → advising；handler 返回 → completed |
| `advising` | 已抛错，正在等 MiniMax 返回诊断 | advising banner | advisor 返回 → retrying / needs_user；advisor 抛错 → needs_user |
| `retrying` | applyAction（reload/reopen/retry_same）正在执行 | retrying banner | applyAction 抛错 → running（再 attempt）；applyAction 返回 → running（再 attempt） |
| `needs_user` | 终止，需要用户手动处理 | needs_user banner（带 attempts + userInstruction） | 第二次进入 phase → running |
| `completed` | 阶段成功完成 | phase 标 done；不影响 banner | 第二次进入 phase → running（**不归档 attemptsHistory**，因为没有需要保留的失败诊断） |

### 关键不变量

- `attempts.length ≤ MAX_PHASE_ATTEMPTS (=3)`
- `attempts[].attempt ∈ [1, MAX_PHASE_ATTEMPTS]`，严格递增
- `attemptsHistory[]` 仅在 state=needs_user 后被再次进入 phase 时写入；completed 不归档
- 同一 run 内 `attemptsHistory + attempts` 在 UI 中合并，按时间排序，`slice(-3)`

---

## 2 · `makeCtx` 的 productIdExists 重读

之前 `makeCtx` 把 `productId` 闭包变量直接转成 `productIdExists`，但 basic 阶段
成功调用 `setProductId(projectId, productId)` 后，本地闭包仍持有旧值；后续 phase
若被外部（orphan recover / UI 重试 / 切账号）触发再次进入 phase，闭包里的
`productIdExists` 可能是 stale `false`，advisor 会误以为「还没有产品 ID」。

修复：

```ts
const makeCtx = (phase, execute, phaseIndex): RecoveryContext => {
  // 每次进入都从 DB 拿最新值，避免闭包 stale
  const latestProductId = this.db.getProject(projectId)?.productId;
  return {
    run,
    phase,
    completedPhases: draftPhases.slice(0, phaseIndex),
    productIdExists: Boolean(latestProductId),
    basicInfoSaved, // 同步读取：basicInfoSaved 只在 basic 成功后置位一次
    execute,
    ...
  };
};
```

`basicInfoSaved` 保留同步读取：它由同一 runner 在 basic 成功后置位，不会被外部并发
覆盖；如果改成 DB 读反而引入「runner 写完还没刷新就被外部读到」的窗口。

---

## 3 · AI outputGuide 加 commercial 字段说明

`outputGuide` 增加 `/commercial/pricing`、`/commercial/inventory`、`/commercial/release`
的合法形状 + 不变量说明：

- `pricing`：必须有 `adult`、`child`、`minimumTravelers`，可选 `cost`；`cost.adult ≤ adult`
- `inventory`：`startDate ≤ endDate`，`dailyQuota` 正整数
- `release`：`publicPriceCeiling > 0`，`publicAuditRetries ∈ [1, 10]`

Zod schema 在 minimax.ts 内对每条 patch 严格校验；任何不合法的 patch 会被静默丢弃，
不会污染产品草稿。测试覆盖 `cost.adult > adult`、`startDate > endDate`、`child=0`
（合法）、部分合法部分非法混合。

---

## 4 · UI 完整 issues + confirm 高亮 + openLogin 保留

### E-A · Step 2 完整 issues

`review-summary`（vbk stage）把 `.review-checklist` 升级为 `.review-checklist--full`，
取消 `slice(0, 4)`，列表容器加 `max-height: 280px; overflow-y: auto`（超出滚动，
但不超过约 12 行可见）。`readiness-hero` 在 `issues.length > 4` 时显示
「还有 N 项，回到上一步查看完整列表」链接，点击 `openStage("review")` 切回 stage=review。

Step 1（review stage）保持原样：4 条限制可保留，避免审查面板被未解决问题撑得太长。

### E-B · confirmTask 1.2s 绿色闪动

新增 `justConfirmedTaskId` state；`confirmTask` 成功后置位，1.2s 后自动清空。
`<button data-just-confirmed={...}>` 上挂 `@keyframes row-confirmed-flash`（background
从 `#dcfce7` → `transparent`），让运营一眼看到刚才点过的那条。

### E-C · openLogin 不清项目

旧版 `openLogin` 会 `setProject(null)`，让 login-stage 渲染并显示登录浏览器。
修复后只打开 `loginPanelOpen`、切到 vbk stage、把 vbk 登录态清空，**不**清项目。
运营可以在审查 / AI 对话界面同时打开登录面板；切完账号关掉登录面板即可继续。
项目面板的关闭只通过面包屑「项目」主动返回。

### E-D · watcher ↔ 填表函数映射

`ctrip.ts` 的 `assertBasicInfoNoRedErrors` 顶部加注释表：

```
watched               ⇒  填表函数
"国家景区"             ⇒  fillScenicAreaProvince / fillScenicAreaSpots
"提前预订"             ⇒  fillAdvanceBooking
"地接社"              ⇒  fillLocalTravelAgency
"管家"               ⇒  fillButlerContact
```

改页面结构时必须同步更新两边。

---

## 5 · 测试覆盖

新增 7 套测试，全部基于 `node:test` + `assert/strict`，无第三方 mock 框架：

| 文件 | 行数 | 覆盖 |
| --- | --- | --- |
| `test/database-orphan-recovery.test.ts` | 6 | orphan run → failed + needs_user；history 归档；warning 日志；非 running run 不动 |
| `test/provider-id-cache.test.ts` | 11 | providerIdFor / setProviderIdFor / listKnownAccounts 三方法边界 |
| `test/ipc-coverage.test.ts` | 4 | preload ↔ main ↔ contracts VbkApi 三方同步 |
| `test/minimax-pricing-patch.test.ts` | 5 | 合法 pricing/inventory/release 接受；非法 cost.adult > adult / startDate > endDate 拒绝；混合 patch 部分接受 |
| `test/recovery-attempt-history.test.ts` | 5 | 同 runner 重入 phase 历史归档；多次重入累积；completed 不归档；诊断字段保留；history 与 attempts 数据隔离 |
| `test/open-product-json.test.ts` | 6 | projects:updateProductJson：合法 / 非法 JSON / 协议违反 / 项目不存在 / 空对象 / 字段覆盖 |
| `test/scheduler-fire-and-forget.test.ts` | 7 | scheduleProviderIdRefresh：成功 / 重试成功 / 两次失败 → null / 第一次成功后不再探测 / null 也算成功 / 无 page no-op / 永不抛错 |

baseline 250 测试 → 当前 294 测试，全部 pass。

---

## 6 · IPC 边界

`VbkApi` 的所有方法在 main 都注册了 ipcMain.handle；测试通过
`test/ipc-coverage.test.ts` 静态校验保证不会漂移。

### 已注册（`ipcMain.handle`）

| category.method | channel | main 实现 |
| --- | --- | --- |
| `projects.list` | `projects:list` | `db.listProjects()` |
| `projects.create` | `projects:create` | `db.createProject(input)` |
| `projects.get` | `projects:get` | `db.getProject(id)` |
| `projects.delete` | `projects:delete` | `db.deleteProject(id)` |
| `projects.readiness` | `projects:readiness` | `readiness(id)` |
| `projects.updateProductJson` | `projects:updateProductJson` | 解析 → parseProduct → updateProduct |
| `projects.updateReviewField` | `projects:updateReviewField` | applyManualReviewField + parseProduct |
| `ai.send` | `ai:send` | main → minimax service.reply |
| `ai.regenerate` | `ai:regenerate` | 重发 + patch |
| `research.accept` | `research:accept` | markResearchAccepted |
| `research.resolveVehicleResource` | `research:vehicleResource` | resolveVehicleResource |
| `research.previewVehicleResourceByPrice` | `research:previewVehicleResourceByPrice` | 价格预览 |
| `research.confirmVehicleResourcePreview` | `research:confirmVehicleResourcePreview` | 确认价格预览 |
| `research.resolveHotelResource` | `research:hotelResource` | resolveHotelResource |
| `browser.*` | `browser:*` | VbkBrowser 各方法 |
| `automation.start / retry / retryPhase` | `automation:*` | DraftAutomation |
| `accounts.*` | `accounts:*` | db / detectProviderId / fixedInfo |
| `contacts.listProviderContactCards` | `contacts:listProviderContactCards` | listProviderContactCards |
| `settings.*` | `settings:*` | main 配置 + MiniMax 连接测试 |
| `events.onProjectUpdated` | `project:updated` (event) | emitProject 推送 |

### 未在 VbkApi 暴露（main 内部事件通道）

- `project:updated` — 内部推送项目更新给渲染端；renderer 用 `events.onProjectUpdated` 订阅。

### 显式 throw（不让 UI 误以为成功）

- `projects.delete`：项目在 `automating` / `running` 时 throw `项目正在自动录入`
- `projects.delete`：项目存在未回复 user message 时 throw `AI 正在处理这个项目`
- `projects.get`：项目不存在 throw `projectNotFound`
- `projects.updateProductJson`：JSON.parse 失败 throw `产品 JSON 无法解析`；parseProduct 失败透传 zod issue
- `projects.updateReviewField`：`applyManualReviewField` 在 adult≤0 / child<0 时 throw
- `automation.start`：项目已在 running → throw `该项目的自动录入正在进行中`
- `accounts.saveFixedInfo`：非法 ContactCardSelection 透传 throw
- `browser.status` 携带 `withKnownVbkAccount` 包装，unknown 账号在 main 抛错
- `settings.test`：URL 不是 http(s) / loopback 时 throw `MiniMax 服务地址必须使用 https://`

---

## 7 · 验证

```bash
npm run check   # tsc --noEmit + tsc -p tsconfig.renderer.json
npm test        # 294 tests, 0 fail
```

人工 smoke（依赖真 VBK 浏览器，不自动化）：

1. 创建非太原（"大同"）私家团 → vehicleResource search 失败时 UI 显示明确提示
2. AI 给出 `/commercial/pricing` patch → readiness 为 0 项可以录入
3. 重启 app 时若项目 automation 处于 running → UI 直接显示 needs_user banner 列出上次失败诊断

---

## Critical Files Modified

| 文件 | 内容 |
| --- | --- |
| `src/main/automation.ts` | makeCtx 重读 productId；makeCtx 改回函数表达式 |
| `src/renderer/App.tsx` | recoveryNeedsUser 合并 history + current；review-summary 完整 issues；readiness-hero-meta-link；confirmTask 高亮；openLogin 不清项目 |
| `src/renderer/styles.css` | review-checklist--full / readiness-hero-meta-link / task-row-grid flash |
| `src/main/minimax.ts` | outputGuide 加 commercial 字段形状说明 |
| `src/main/database.ts` | recoverOrphanAutomationRuns 同时把 project.status 置 blocked；listKnownAccounts 不再泄漏 providerId 字符串 |
| `src/main/main.ts` | 注册 projects:updateReviewField IPC handler |
| `src/main/automation/ctrip.ts` | watcher ↔ 填表函数映射文档 |
| 7 个 `test/*.test.ts` | 新测试文件 |

## Critical Files Read (for context)

- `src/shared/contracts.ts` — PhaseRecovery / VbkApi 形状
- `src/main/automation/recovery.ts` — runner 主循环（attempt=1..3 → advisor → applyAction）
- `src/main/automation/schema.ts` — productSchema 与 parseProduct