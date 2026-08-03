# VBK Desktop — 产品审查 + VBK 录入问题修复计划

> **状态：✅ 全部完成（2026-08-03 session 结束）**
> 验收：`npm run check` 干净，`npm test` 294/294 通过（基线 250 → 294，新增 44）。
> 提交：D-A / D-B / E / F / G 五个独立 commit 已落到 main。
> 设计文档：`docs/superpowers/specs/2026-08-03-product-review-fixes-design.md`
> Session 移交：`docs/superpowers/plans/2026-08-03-session-closeout.md`

---

## 完成结果总览

### ✅ 已完成（基线 250 → 294 / 0 fail）

| 改动 | 文件 | 状态 |
| --- | --- | --- |
| `db.recoverOrphanAutomationRuns()` + project.status 同步置 blocked | `src/main/database.ts` | ✅ |
| `providerIdFor/setProviderIdFor/listKnownAccounts`（修复数字泄漏） | `src/main/database.ts` | ✅ |
| `db-errors.ts` 新模块 | `src/main/db-errors.ts` | ✅ |
| `scheduleProviderIdRefresh()` fire-and-forget | `src/main/provider-id-source.ts` | ✅ |
| Main: 注册全部 IPC（含 `projects:updateReviewField`） | `src/main/main.ts` | ✅ |
| `recoverOrphanAutomationRuns` 启动时跑 | `src/main/main.ts` | ✅ |
| 批次 B：AI 可写 pricing/inventory/release | `src/main/minimax.ts` `src/main/product-normalize.ts` | ✅ |
| 批次 C：车辆估算去硬编码 + 没结果抛错 | `src/main/vehicle-resource.ts` | ✅ |
| **D-A** recovery attempts history UI 集成 | `src/main/automation.ts` `src/renderer/App.tsx` `src/renderer/styles.css` | ✅ |
| **D-B** AI outputGuide 增 commercial 字段 | `src/main/minimax.ts` | ✅ |
| **E-A** Step 2 完整 issues + 回到上一步 | `src/renderer/App.tsx` `src/renderer/styles.css` | ✅ |
| **E-B** confirmTask 1.2s 绿色闪动 | `src/renderer/App.tsx` `src/renderer/styles.css` | ✅ |
| **E-C** openLogin 不清项目 | `src/renderer/App.tsx` | ✅ |
| **E-D** watcher ↔ 填表函数映射文档 | `src/main/automation/ctrip.ts` | ✅ |
| **F** 7 套测试 | `test/*.test.ts` | ✅ |
| **G** 设计文档 | `docs/superpowers/specs/2026-08-03-product-review-fixes-design.md` | ✅ |

### ⚠️ 顺手修复的两个 bug

1. `database.ts:listKnownAccounts` 之前把 `providerIdByAccount:*` 的 value（数字化的 providerId 字符串）当账号名加进 names 集合，导致 providerId 数字（如 "1"、"2"）泄漏到顶栏 / 设置页账号列表。已修复：`if (row.key === "vbkAccountName")` 才把 value 当账号名。
2. `database.ts:recoverOrphanAutomationRuns` 之前只改 `automation.status`，没改 `project.status`，UI 会停留在「automating」但 run 已是 `failed` 的不一致状态。已修复：同时把 project.status 置为 blocked（除非已经是 draft_saved / blocked）。

### 已知未做（不属于本计划）

- 人工 smoke 验证（依赖真 VBK 浏览器，不在本 session 范围）：
  1. 创建非太原（"大同"）私家团 → vehicleResource search 失败时 UI 明确提示
  2. AI 给出 `/commercial/pricing` patch → readiness 为 0 项可录入
  3. 重启时若 automation=running → 直接显示 needs_user banner 列出上次失败诊断

---

## 详尽清单（历史，原 plan 内容保留作为审计轨迹）

### 当前状态（plan 起始时）

- 测试基线 250；`npm run check` 与 `npm test` 干净。
- 老 vehicle-resource 测试已重写。
- `minimax.ts outputGuide` 未列 pricing/inventory/release。

### D-A · recovery attempts history UI 集成 ✅

- [x] `src/main/automation.ts`
  - makeCtx 里 productIdExists 改为每次进入时再读 `db.getProject(projectId).productId`；保留 basicInfoSaved 同步读取
- [x] `src/renderer/App.tsx`
  - recoveryNeedsUser 函数合并 attemptsHistory + attempts 后 slice(-3)
  - 每条 attempt 加 seq/round（"第 1 次（历史）" vs "第 1 次"）
- [x] `test/recovery-attempt-history.test.ts`（新增，5 用例）
  - 两轮 3+3 失败 → attemptsHistory 保留上轮 3 条，attempts 是新轮
  - 连续三轮 → attemptsHistory 累积 6 条
  - 成功完成后重入 → 不归档，attemptsHistory 为空
  - 归档保留 diagnosis 字段
  - attempts 与 attemptsHistory 数据隔离

### D-B · AI outputGuide + pricing 端到端测试 ✅

- [x] `src/main/minimax.ts` outputGuide 加 pricing/inventory/release 形状 + 不变量
- [x] `test/minimax-pricing-patch.test.ts`（新增，5 用例）
  - 合法 pricing/inventory/release 三条 patch → 全部接受
  - cost.adult > adult → service 拒绝
  - startDate > endDate → service 拒绝
  - 省略 cost 字段（合法）→ 接受
  - 合法 + 非法混合 → 只接受合法

### E-A · UI 完整 issue 列表 ✅

- [x] `src/renderer/App.tsx`
  - review-summary 里改 `.review-checklist` 为 `.review-checklist--full`，去掉 slice(0, 4)
  - readiness-hero 加 `还有 X 项，回到上一步查看完整列表` 链接（issues.length > 4 时）
- [x] `src/renderer/styles.css`
  - `.review-checklist-list--full { max-height: 280px; overflow-y: auto; padding-right: 4px; }`
  - `.readiness-hero-meta-link { color: var(--link); font-size: var(--fs-xs); cursor: pointer; }`

### E-B · confirmTask 高亮 ✅

- [x] `src/renderer/App.tsx`
  - 新增 `justConfirmedTaskId` state
  - confirmTask 成功置位，1.2s 后清空
  - task-row 上加 `data-just-confirmed={...}` 属性
- [x] `src/renderer/styles.css`
  - `.task-row-grid[data-just-confirmed='true'] { animation: row-confirmed-flash 1.2s ease-out; }`
  - `@keyframes row-confirmed-flash { 0% { background: #dcfce7; } 100% { background: transparent; } }`

### E-C · openLogin 不清项目 ✅

- [x] `src/renderer/App.tsx` openLogin 删除 `setProject(null)`：项目保持可见，运营可继续审查 / AI 对话；项目面板关闭只通过面包屑「项目」主动返回。

### E-D · watcher 文档 ✅

- [x] `src/main/automation/ctrip.ts` 顶部 assertBasicInfoNoRedErrors 注释里列出 watcher ↔ 填表函数表：
  ```
  watched               ⇒  填表函数
  "国家景区"             ⇒  fillScenicAreaProvince / fillScenicAreaSpots
  "提前预订"             ⇒  fillAdvanceBooking
  "地接社"              ⇒  fillLocalTravelAgency
  "管家"               ⇒  fillButlerContact
  ```

### F · 新测试 ✅

| 文件 | 用例数 |
| --- | --- |
| `test/database-orphan-recovery.test.ts` | 6 |
| `test/provider-id-cache.test.ts` | 11 |
| `test/ipc-coverage.test.ts` | 4 |
| `test/minimax-pricing-patch.test.ts` | 5 |
| `test/recovery-attempt-history.test.ts` | 5 |
| `test/open-product-json.test.ts` | 6 |
| `test/scheduler-fire-and-forget.test.ts` | 7 |
| **合计** | **44** |

### G · 设计文档 ✅

- [x] `docs/superpowers/specs/2026-08-03-product-review-fixes-design.md`
  - recovery 状态机（running / advising / retrying / needs_user / completed）转换图
  - IPC 边界表：哪些 contracts 方法已注册 / 哪些显式 throw / 哪些是内部事件通道
  - 7 套测试覆盖表
  - 验证检查表

---

## 验收结果

```bash
$ npm run check
> tsc --noEmit && tsc -p tsconfig.renderer.json
(无输出 = clean)

$ npm test
1..294
# tests 294
# pass 294
# fail 0
```

基线 250 → 当前 294，全部通过。