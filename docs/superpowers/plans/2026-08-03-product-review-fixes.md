# VBK Desktop — 产品审查 + VBK 录入问题修复计划

## 当前状态

### ✅ 已完成（300 个测试之前一直是 250/250 通过；当前测试基线 250）

| 改动 | 文件 | 状态 |
| --- | --- | --- |
| `db.recoverOrphanAutomationRuns()` | `src/main/database.ts` | ✅ 已落 |
| `providerIdFor/setProviderIdFor/listKnownAccounts` | `src/main/database.ts` | ✅ 已落 |
| `db-errors.ts` 新模块 | `src/main/db-errors.ts` | ✅ 已落 |
| `scheduleProviderIdRefresh()` | `src/main/provider-id-source.ts` | ✅ 已落 |
| Main: 注册全部缺失的 IPC + retry 真接 retryPhase | `src/main/main.ts` | ✅ 已落 |
| `recoverOrphanAutomationRuns` 启动时跑 | `src/main/main.ts` | ✅ 已落 |
| 批次 B：AI 可写 pricing/inventory/release | `src/main/minimax.ts` `src/main/product-normalize.ts` | ✅ 已落 |
| 批次 C：车辆估算去硬编码 + 没结果抛错 | `src/main/vehicle-resource.ts` | ✅ 已落 |
| 批次 D（部分）：recovery attempts 历史保留 | `src/shared/contracts.ts` `src/main/automation/recovery.ts` | ⚠️ **半成品** —— 见下方 |

### ⚠️ 已动手但需下个 session 收尾

1. **`src/shared/contracts.ts`** — `PhaseRecovery.attemptsHistory?` 已加。
2. **`src/main/automation/recovery.ts`** — 入口逻辑改了：老 attempts 归档到 `attemptsHistory`，再清 `rec.attempts`。
3. **批次 D 还没做：**
   - UI 渲染时合并 `rec.attemptsHistory` + `rec.attempts` 显示在 needs_user banner 里（改 `App.tsx` 里的 `recoveryBlocked.attempts` 来源）。
   - `automation.ts` 里 basic 阶段 `productIdExists` 取最新值（避免 advisor 第一次看到 stale false）。
4. **批次 E 全部：UI 完整 issues / confirmed 高亮 / openLogin 不清 project / styles.css keyframes** —— 一个都没做。
5. **批次 F：补测试 7 套** —— 还没动手。
6. **设计文档** —— 还没写。

### 已知对类型/测试的回归影响

- `npm run check` 与 `npm test` 当前都干净（250 pass / 0 fail）。
- 老的 vehicle-resource 测试因为 `estimateVehicleResource` 被删除而重写，5 个用例都覆盖「无硬编码 dailyCost / 无城市抛错」语义。
- `minimax.ts` `outputGuide` 没改；要让 AI 真正能输出 pricing patch，outputGuide 里需要列出 pricing/inventory/release。下面的 D-B 子项会有这个。

---

## 下个 session 待办清单（按依赖顺序）

### D-A · recovery attempts history UI 集成

**预期**：用户在 banner 里能看到上一次失败 + 本次失败两轮的 attempt 列表。

- [ ] `src/main/automation.ts`
  - `makeCtx` 里 `productIdExists` 的取值改为「每次进入时再读 `db.getProject(projectId).productId`」的最新值；保留 basicInfoSaved 同步读取
- [ ] `src/renderer/App.tsx`
  - 改 `RecoveryNeedsUser.attempts` 的拼装：在 `recoveryNeedsUser` 函数里，把 `rec.attempts` 与 `rec.attemptsHistory` 合并后再 slice(-3)
  - 给每条 attempt 一个 `seq` 字段（例如 `${attemptHistory.attempt}` 或 `${attemptHistory.attempt}+历史`），列表展示「第 1 次历史 / 第 1 次」让运营分得清两轮
- [ ] `test/recovery-attempt-history.test.ts`（新增）
  - 「第二次进入 phase 时 attempts 历史保留」：走两轮 3+3 失败，第二次进入前 `rec.attemptsHistory` 应有上轮 3 条，第二次结束时 `rec.attempts` 有第二轮 3 条
  - 「phase 成功完成后再进入 phase → 不归档」（保持现状）

### D-B · AI outputGuide + pricing 端到端测试

**预期**：模型能补齐 pricing/inventory/release 后，readiness 立刻通过。

- [ ] `src/main/minimax.ts` — `outputGuide` 增加「可以写 /commercial/pricing、/commercial/inventory、/commercial/release」
- [ ] `test/minimax-pricing-patch.test.ts`（新增）
  - AI 返回 `/commercial/pricing` / `/commercial/inventory` / `/commercial/release` 三条 patch；`service.reply` 必须把这些合法写入
  - AI 返回 `cost.adult > adult`（违规）的 pricing → service 拒绝
  - AI 返回 startDate > endDate 的 inventory → service 拒绝

### E-A · UI 完整 issue 列表

**预期**：Step 2 的 review-summary 显示完整 readiness issues（不只前 4 条），但用滚动容器最高 12 行。

- [ ] `src/renderer/App.tsx`
  - 在 review-summary 里改 `.review-checklist` 为 `.review-checklist--full`，去掉 `slice(0, 4)`，给容器加 `max-height: 320px; overflow-y: auto;`
  - 顶部 hero 加 `还有 X 项，回到上一步查看完整列表` 链接，点击切回 stage=review 并 scrollIntoView 到对应 issue
- [ ] `src/renderer/styles.css`
  - `.review-checklist-list--full { max-height: 280px; overflow-y: auto; padding-right: 4px; }`
  - `.readiness-hero-meta-link { color: var(--link); font-size: var(--fs-xs); cursor: pointer; }`

### E-B · confirmTask 高亮

**预期**：运营点保存并写入 → 刚确认的 task 在 1.2s 内淡绿色高亮。

- [ ] `src/renderer/App.tsx`
  - 给 `confirmTask` 加 `setJustConfirmedTaskId(activeTask.id)`，1.2s 后清掉
  - task-row 上加 `data-just-confirmed={...}` 属性
- [ ] `src/renderer/styles.css`
  - `.task-row-grid[data-just-confirmed='true'] { animation: row-confirmed-flash 1.2s ease-out; }`
  - `@keyframes row-confirmed-flash { 0% { background: #dcfce7; } 100% { background: transparent; } }`

### E-C · openLogin 不清项目

**预期**：打开登录窗口时当前项目仍可见，运营切回登录仍能继续编辑。

- [ ] `src/renderer/App.tsx` — `openLogin` 里 `setProject(null)` 改为只在「当前账号与目标账号不同」时清；同一账号下切回登录视图不清项目。

### E-D · watcher 文档

- [ ] `src/main/automation/ctrip.ts` 顶部 `assertBasicInfoNoRedErrors` 注释里列出 watcher 与对应填表函数的一一对应表：

```
watched               ⇒  填表函数
"国家景区"             ⇒  fillScenicAreaProvince / fillScenicAreaSpots
"提前预订"             ⇒  fillAdvanceBooking
"地接社"              ⇒  fillLocalTravelAgency
"管家"               ⇒  fillButlerContact
```

### F · 新测试

| 文件 | 覆盖 |
| --- | --- |
| `test/database-orphan-recovery.test.ts` | orphan automation runs 启动时变 failed + needs_user；history 也被归档 |
| `test/provider-id-cache.test.ts` | providerIdFor/setProviderIdFor/listKnownAccounts 三方法 |
| `test/ipc-coverage.test.ts` | 静态扫 contracts.ts 与 preload.cts 的 invoke channel vs main.ts 的 ipcMain.handle；缺一个就挂 |
| `test/minimax-pricing-patch.test.ts` | 见 D-B |
| `test/recovery-attempt-history.test.ts` | 见 D-A |
| `test/open-product-json.test.ts` | projects:updateProductJson IPC：合法 JSON 写入并 updateProduct；非法 JSON 抛错；产品协议被违反抛错 |
| `test/scheduler-fire-and-forget.test.ts` | scheduleProviderIdRefresh：成功 / 失败重试 / 失败两次写 null 三条路径 |

### G · 设计文档

- [ ] `docs/superpowers/specs/2026-08-03-product-review-fixes-design.md`
  - 状态机：recovery 的 completed/needs_user/advising/retrying/running 转换图
  - IPC 边界：哪些 contracts 方法在 main 注册 / 暂未实现 / 显式 throw

---

## 验证检查表（最后跑一遍）

```bash
npm run check                                       # tsc 干净
npm test                                            # 全 pass，新测试 7+ 文件已落
```

人工 smoke（不要自动化，因为依赖真 VBK 浏览器）：
1. 创建非太原（"大同"）私家团 → vehicleResource search 失败时 UI 显示明确提示
2. AI 给出 `/commercial/pricing` patch → readiness 为 0 项可以录入
3. 重启 app 时若项目 automation 处于 running → UI 直接显示 needs_user banner 列出上次失败诊断

