# 行程景点稳定 spotId 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 `ItinerarySpot` 加稳定的 `spotId`。已核验 POI 保留、人工删除记录、POI 核查任务结清和人工审查编辑都优先按 spotId 对齐；没有 spotId 时，统一回退到 `poiNameKey`。

**Architecture:** 新建一个共享模块 `src/shared/itinerary-spot-identity.ts`，负责生成、继承和补齐 spotId，并提供统一的名称键。

- **继承**：只在 `ProductMutationService.replace` 这一处做，把旧方案的 ID 按规则分配给新方案。
- **补齐**：数据库 `updateProduct`、产品导入和一次性迁移只负责给缺 ID 的景点补上。
- **不暴露给模型**：spotId 不进入模型上下文。
- **不参与指纹**：spotId 不进入审批指纹和录入阶段指纹，所以补 ID 不会让旧审批或已完成阶段失效。

**Tech Stack:** TypeScript、zod、better-sqlite3、node:test（`npm test` / `npm run test:changed`）

**Spec:** 本文件「背景与决策」一节（来源：2026-10-29 方案审查阶段架构审查，问题 1）

## 背景与决策

现状是景点只有 `name/poiName/poiId`。三处对齐都靠名字，而且归一化规则各不相同：

- `preserveVerifiedItineraryPois` 只做 trim（`src/main/application/product-mutation-service.ts:145-180`）。
- 核查任务凭证去掉全部空白，凭证本身是自由文本，用正则解析（`src/main/infrastructure/database/parts/verified-poi-research.ts:128-139`）。
- 删除记录依次比较 poiId、poiName、name（`src/shared/preserve-itinerary-removals.ts:55-62`），而 `trusted-operator-itinerary-removals.ts` 只去空白。

人工审查编辑按 `dayIndex/spotIndex` 定位，行程被别处改写后可能写到错误的景点上。

已定决策：

1. **格式**：`spotId` 为 `sp_` 加 12 位小写十六进制，取 `randomUUID()` 去掉横线后的前 12 位。字段可选，模型 schema 不要求它。
2. **继承规则**（`inheritItinerarySpotIds(previous, next)`）：同一份新方案内一个 ID 只能用一次，依次尝试：
   - a. 新景点已带 spotId，旧方案中存在，且本轮未被占用，就保留，可以跨天。
   - b. 同一天、`poiNameKey(name)` 相同、尚未被继承的旧景点，按出现顺序一对一继承。
   - c. 同一天、`poiId` 为正整数且相同的旧景点，一对一继承。
   - d. 以上都不满足时生成新 ID。新方案内的重复 ID 从第二次出现起改发新 ID。
3. **删除记录仍需名字兜底**：被删景点已不在方案里，重新生成的同名景点拿不到旧 ID。所以 spotId 只用来精确定位被删的那个槽位和判断「原槽位重新出现」，「不得恢复该地点」仍按 `poiNameKey` 判断。原来只去空白的比较统一改成 `poiNameKey`，这是有意放宽的行为变更：`广济桥（不上桥）` 的删除记录也会拦住 `广济桥`。`poi-name-key.ts` 的注释已经要求删除记录、核查任务和编号路线共用这把尺子。
4. **POI 保留**：两侧都有 spotId 时，要求 spotId、天、kind 都相同；任一侧缺 ID 时按「同天 + `poiNameKey` + kind」。改名后仍不保留 POI，与现有行为一致。
5. **指纹排除**：`legacyProductVersion` / `approvedPlanVersion` 和 `entryPhaseInput` 计算前剥掉 spotId。`preparation/director.ts` 本身按白名单取字段，不需要改。
6. **模型隔离**：`planning-prompt.ts` 的 `FORBIDDEN_CONTEXT_KEYS` 加入 `spotId`。模型 tool schema 和 patch schema 不增加该字段，模型输出里没有 spotId，由继承逻辑补上。

## Global Constraints

- 每个文件 ≤ 350 行，含空行与注释。落地前用 `wc -l` 自查，超过就拆分。
- 不得放宽或绕过任何生产门禁。补 spotId 不得改变 `approvedPlanVersion` 和 `entryPhaseInputFingerprint` 的结果。
- 不触发 VBK 提审或发布，不修改业务数据库。迁移只在用户本机启动时执行，执行前沿用现有 `VACUUM INTO` 备份机制。
- 交付前必须运行 `npm run test:changed`，确认收据包含 5 项正向和 20 项负向；否则补跑 `npm run test:e2e`。另需 `npm run check` 和 `npm run build` 通过。
- 中文注释与提交说明，提交时附 Co-Authored-By 行。

## Review Focus

1. 同一天两个同名景点（如上午、下午各去一次同一个景点）：继承和 POI 保留必须一对一，不能两个都继承第一个的 ID 或 POI。测试归 Task 1 和 Task 4。
2. 模型重排同一天的景点顺序：ID 跟着名字走，不跟下标走，POI 不能错位。测试归 Task 1。
3. 补 ID 迁移之后，旧产品的已批准审批和已完成录入阶段仍然有效。测试归 Task 2 和 Task 3。
4. 渲染端拿着旧的 `spotIndex` 发起人工编辑，期间行程已被 Agent 改写：必须拒绝，不能写到错误的景点。测试归 Task 7。
5. 二选一组内删除一项后再重新生成：组内其它项不能被误判为已删除，被删项不能复活。测试归 Task 5。

---

### Task 1: spotId 身份模块

**Files:**
- Create: `src/shared/itinerary-spot-identity.ts`
- Modify: `src/shared/contracts-types/itinerary.ts:16-35`（`ItinerarySpot` 加 `spotId?: string`）
- Test: `test/shared/itinerary-spot-identity.test.ts`

**Interfaces:**
- Produces:
  - `newItinerarySpotId(): string`：返回 `sp_` 加 12 位十六进制。
  - `isItinerarySpotId(value: unknown): value is string`：判断是否符合 `/^sp_[0-9a-f]{12}$/`。
  - `itinerarySpotKey(name: unknown): string`：等同 `poiNameKey`，作为唯一的景点名称比较入口。
  - `inheritItinerarySpotIds(previous: Record<string, unknown>, next: Record<string, unknown>): Record<string, unknown>`：返回 next 的深拷贝，并按决策 2 写好 `spots[].spotId`。不修改入参。
  - `ensureItinerarySpotIds(product: Record<string, unknown>): Record<string, unknown>`：只给缺失或非法 ID、或在方案内重复的景点补新 ID。没有任何变化时返回原对象引用。
  - `findItinerarySpot(product, spotId): { dayIndex: number; spotIndex: number; spot: Record<string, unknown> } | undefined`

- [ ] **Step 1: 写失败测试**，至少覆盖以下用例：
  - `继承：同天同名一对一`：旧方案第 1 天为 `[A(id1), A(id2)]`，新方案为 `[A, A]`，结果 ID 依次为 `id1, id2`。
  - `继承：重排后 ID 跟名字`：旧方案为 `[A(id1), B(id2)]`，新方案为 `[B, A]`，结果为 `[id2, id1]`。
  - `继承：名称键等价`：旧方案 `广济桥（不上桥）`(id1)，新方案 `广济桥`，结果继承 id1。
  - `继承：不跨天按名`：旧方案第 1 天 `A(id1)`，新方案第 2 天 `A`，结果是新 ID，不等于 id1。
  - `继承：显式 ID 可跨天`：新方案第 2 天 `A(spotId:id1)`，结果保留 id1。
  - `继承：按 poiId 兜底`：旧方案 `古汉台(poiId 9)`(id1)，新方案 `汉中市古汉台博物馆(poiId 9)`，结果继承 id1。
  - `补齐：重复 ID 第二个换新`，以及 `补齐：无变化返回同一引用`（用 `assert.equal(result, input)` 断言）。
- [ ] **Step 2: 运行确认失败。** 命令 `node --import tsx --test test/shared/itinerary-spot-identity.test.ts`，预期报找不到模块。
- [ ] **Step 3: 实现。** 继承按决策 2 的 a 到 d 顺序处理，用 `Set<string>` 记录已占用的旧 ID。非对象形式的 spot（字符串）原样保留。
- [ ] **Step 4: 运行确认通过。**
- [ ] **Step 5: 提交** `feat(itinerary): 新增景点稳定 spotId 的生成与继承`

### Task 2: schema、规范化、模型隔离、指纹排除

**Files:**
- Modify: `src/main/automation/schema/schema-definitions/itinerary.ts`（spot 加 `spotId: z.string().regex(/^sp_[0-9a-f]{12}$/).optional()`）
- Modify: `src/main/planning/itinerary-day-schema.ts`（同样加可选 spotId，否则含 ID 的回读会被 strict 拒绝）
- Modify: `src/main/data/product-normalize/itinerary.ts:57-75`（白名单保留合法 spotId）
- Modify: `src/main/planning/adapters/planning-prompt.ts:69`（`FORBIDDEN_CONTEXT_KEYS` 加 `"spotId"`）
- Modify: `src/main/application/product-approval-projection.ts`（`legacyProductVersion` 中删除每个 spot 的 spotId）
- Modify: `src/main/application/product-entry-phase-fingerprint.ts:22`（`itinerary()` 克隆后剥掉 spotId）
- Test: `test/application/itinerary-spot-id-fingerprint.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `ensureItinerarySpotIds`
- Produces: `stripItinerarySpotIds(itinerary: unknown[]): unknown[]`，放在 `itinerary-spot-identity.ts`，供两个指纹函数共用。

- [ ] **Step 1: 写失败测试**，覆盖以下用例：
  - `补 spotId 不改变审批指纹`：`approvedPlanVersion({product}) === approvedPlanVersion({product: ensureItinerarySpotIds(product)})`。
  - `补 spotId 不改变各录入阶段指纹`：对 `basic/presentation/itinerary/vehicleResource/terms/trafficLine/preflight` 逐个比较 `entryPhaseInputFingerprint`。
  - `规范化保留合法 spotId，丢弃非法值`。
  - `模型上下文不含 spotId`：`JSON.stringify(projectProductContext("itinerary", product))` 不包含 `spotId`。
  - `productSchema 接受带 spotId 的行程`。
- [ ] **Step 2: 运行确认失败。**
- [ ] **Step 3: 按上面的文件清单实现。**
- [ ] **Step 4: 运行通过后再跑 `npm run check`。**
- [ ] **Step 5: 提交** `feat(itinerary): spotId 进入 schema 与规范化，排除于模型上下文和指纹`

### Task 3: 写入链路继承与存量补齐

**Files:**
- Modify: `src/main/application/product-mutation-service.ts:107`。在 `preserveVerifiedItineraryPois` 之前执行 `const withIds = inheritItinerarySpotIds(current.product, product)`，后续步骤都基于 `withIds`。
- Modify: `src/main/infrastructure/database/parts/product-update.ts:22`。`durableInput = ensureItinerarySpotIds(dedupeProductItineraryPois(product))`。
- Modify: `src/main/infrastructure/database/parts/products/import.ts`。在 `parseAndNormalizeProductJson` 之后执行 `ensureItinerarySpotIds`；如果本地已有该产品，先 `inheritItinerarySpotIds(existing.product, product)`。
- Create: `src/main/infrastructure/database/parts/itinerary-spot-id-migration.ts`，导出 `itinerarySpotIdMigration: Migration`，id 为 `"0019_itinerary_spot_id"`。`migrate` 逐行读取 `products.product_json`，用 `ensureItinerarySpotIds` 补齐后只 `UPDATE products SET product_json=?`，不递增 `product_json_version` 和 `plan_version`。
- Modify: `src/main/infrastructure/database/parts/migration-registry.ts:304`，在 `itineraryReviewUnlockMigration` 之后注册。
- Test: `test/application/itinerary-spot-id-persistence.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `inheritItinerarySpotIds` 和 `ensureItinerarySpotIds`，Task 2 的指纹排除。

- [ ] **Step 1: 写失败测试**，覆盖以下用例：
  - `replace 后每个景点都有合法 spotId`。
  - `模型重生成整份行程（不带 ID）后同名景点 ID 不变`：先 replace 一次并记录 ID，再 replace 一份没有 ID 的同名行程，比较前后 ID。
  - `迁移补 ID 不改版本号，已批准审批仍有效`：内存库插入一个无 ID 的产品并写入审批版本，执行 migrate 后断言 `product_json_version` 不变，且 `approvedPlanVersion` 等于审批记录中的版本。
  - `导入远端快照继承本地 ID`。
- [ ] **Step 2: 运行确认失败。**
- [ ] **Step 3: 实现。**
- [ ] **Step 4: 跑 `npm test`。** 凡是把保存后的 `spots` 与字面量做 `deepEqual` 的既有测试会因多出 spotId 而失败。处理方式是在 `test/helpers/` 新增 `withoutSpotIds(value)`，在断言处剥掉 ID 再比较，不得在生产代码里为测试关闭补 ID。逐个修复直到全部通过。
- [ ] **Step 5: 用 `wc -l` 自查改动文件后提交** `feat(itinerary): 保存时继承 spotId，导入与迁移补齐存量`

### Task 4: 已核验 POI 按 spotId 保留

**Files:**
- Modify: `src/main/application/product-mutation-service.ts:145-180`（`preserveVerifiedItineraryPois`）
- Test: `test/application/product-mutation-service.test.ts`（追加用例）

**Interfaces:**
- Consumes: Task 1 的 `itinerarySpotKey`，以及 Task 3 保证 current 和 incoming 都已带 spotId。

- [ ] **Step 1: 写失败测试**，覆盖以下用例：
  - `同天两个同名景点各自保留各自 POI`：旧方案为 `[A(id1,poi 1), A(id2,poi 2)]`，incoming 两项都缺 POI，结果 poiId 依次为 `1, 2`。
  - `名称键等价时仍保留 POI`：旧方案 `广济桥 (poi 5)`，incoming `广济桥（不上桥）` 且没有 ID，结果保留 poi 5。
  - `改名后不保留 POI`：同一个 spotId，但名称键不同，结果 poiId 为 null。
- [ ] **Step 2: 运行确认失败。**
- [ ] **Step 3: 实现决策 4。** 先建 `Map<spotId, spot>`，两侧都有 ID 时按 ID 取旧景点，并要求天、kind、名称键都相同；缺 ID 时按 `day + itinerarySpotKey + kind` 匹配，且每个旧景点只能被用一次。
- [ ] **Step 4: 运行通过。**
- [ ] **Step 5: 提交** `fix(itinerary): 已核验 POI 按 spotId 一对一保留`

### Task 5: 删除记录记录 spotId 并统一名称键

**Files:**
- Modify: `src/shared/trusted-operator-itinerary-removals.ts`。`TrustedItineraryRemoval` 加 `spotId?: string`；`TrustedItineraryRemovalIdentity` 加 `spotId?`；`sameName` 改用 `itinerarySpotKey`；`receiptReappeared` 在凭证带 spotId 时，若当前方案中有相同 spotId 的景点，直接判定为重新出现；`removals()` 解析时保留合法 spotId。
- Modify: `src/shared/preserve-itinerary-removals.ts:55-62`。`matchesReceipt` 先比较 spotId，再比较 poiId、poiName；最后的 `compact` 改为 `itinerarySpotKey`。
- Modify: `src/main/operations/manual-review-itinerary-field.ts:72`。`appendTrustedOperatorItineraryRemoval` 的 identity 带上被删景点的 spotId。
- Test: `test/resources/manual-review-itinerary-removals.test.ts`、`test/application/product-mutation-removals.test.ts`（追加用例）

**Interfaces:**
- Consumes: Task 1 的 `itinerarySpotKey` 和 `isItinerarySpotId`。

- [ ] **Step 1: 写失败测试**，覆盖以下用例：
  - `删除凭证记录 spotId`。
  - `删除带括号注释的景点后，模型以无注释名重新生成，仍被拦截`：删除 `广济桥（不上桥）`，再 replace 含 `广济桥` 的行程，结果 spots 中没有广济桥。
  - `二选一删除一项后重新生成：被删项不复活，同组其余项保留`。
  - `原 spotId 被显式写回时清除凭证`：`clearReappearedTrustedOperatorItineraryRemovals` 遇到 spotId 相同的景点返回 true。
- [ ] **Step 2: 运行确认失败。**
- [ ] **Step 3: 实现。**
- [ ] **Step 4: 运行通过，再跑 `test/planning/numbered-route-constraints*`、`itinerary-input-contract-trusted-removals` 回归。**
- [ ] **Step 5: 提交** `fix(itinerary): 删除凭证记录 spotId，名称比较统一为 poiNameKey`

### Task 6: POI 核查任务按 spotId 结清

**Files:**
- Modify: `src/main/planning/types.ts:54-62`。`VerifiedPoiMapping` 加 `spotId?: string`。
- Modify: `src/shared/contracts-types/conversation.ts:25-32`。`Evidence` 加 `poiMappings?: Array<{ day: number; spotId?: string; spotName: string; poiName: string; poiId: number }>`。
- Modify: `src/main/planning/poi-enrichment.ts:256-269`。`recordVerifiedMapping` 从 `day.spots` 里当前被核验的景点读取 spotId 写入 mapping，需要把调用处的 `spot` 传进来。
- Modify: `src/main/agent/integration/tools.ts:212-215`，mapping 加 `spotId: cleanText(spot.spotId) || undefined`。
- Modify: `src/main/operations/manual-review-poi-selection.ts:103-115`，返回值加 spotId。
- Modify: `src/main/infrastructure/database/parts/verified-poi-research.ts`：
  - 写凭证时同时写 `poiMappings` 结构化字段，保留原 title 文本以兼容旧读取。
  - 读凭证时优先读 `poiMappings`，没有时才走现有正则。
  - `persistedMappingExists` 和 `everyCurrentSlotVerified` 在 mapping 与景点都有 spotId 时按 spotId 加 poiId 匹配，否则走现有逻辑；`sameName` 改用 `itinerarySpotKey`。
- Test: `test/infrastructure/verified-poi-research.test.ts`（没有就新建）

**Interfaces:**
- Consumes: Task 1 的 `itinerarySpotKey`，Task 3 保证落库的景点都有 spotId。

- [ ] **Step 1: 写失败测试**，覆盖以下用例：
  - `同名跨日两个槽位：只核验了第 1 天时任务不结清`，即 spotId 不同时不能互相作证。
  - `凭证写入结构化 poiMappings 且可回读`。
  - `旧格式文本凭证仍可结清`，用现有 `[itinerary-poi:verified] 第1天 A -> A官方 (9)` 格式。
  - `景点改名但 spotId 与 poiId 未变，凭证仍有效`。
- [ ] **Step 2: 运行确认失败。**
- [ ] **Step 3: 实现。**
- [ ] **Step 4: 运行通过，再跑 `test/agent` 中与 POI 相关的测试。**
- [ ] **Step 5: 用 `wc -l` 自查 `poi-enrichment.ts`（当前 336 行）。如果超过 350 行，把 `recordVerifiedMapping` 和 `bracketAliases` 拆到 `poi-enrichment/mappings.ts` 后再提交** `fix(poi): 核查任务凭证按 spotId 结构化对齐`

### Task 7: 人工审查编辑携带 spotId 防错位

**Files:**
- Modify: `src/shared/contracts-types/manual-review.ts`。`itinerarySpotPoi`、`itinerarySpotKind`、`itinerarySpotRemove` 三种输入加 `spotId?: string`。
- Modify: `src/main/operations/manual-review-itinerary-field.ts`。三个 apply 函数在 `input.spotId` 存在且与 `spots[spotIndex].spotId` 不一致时，抛出 `"行程已变更，请刷新后重试。"`。
- Modify: `src/renderer/app/views/workspace/review-summary-itinerary-timeline.ts`。时间线条目带出 `spotId`。
- Modify: `src/renderer/app/views/workspace/use-itinerary-spot-removal.ts:50`、`review-summary-itinerary.tsx:76`、`review-summary-itinerary-poi.tsx`（三处提交），提交时带上 `spotId`。
- Test: `test/resources/manual-review-itinerary-spot-guard.test.ts`

**Interfaces:**
- Consumes: Task 1 的 spotId 字段。

- [ ] **Step 1: 写失败测试**，覆盖以下用例：
  - `spotIndex 处已不是原景点时拒绝删除`：输入 `spotId` 为 id1，而 `spots[0]` 是 id2，`assert.throws` 匹配 `/行程已变更/`。
  - `spotId 一致时正常绑定 POI`。
  - `未携带 spotId（旧客户端）按原逻辑执行`。
- [ ] **Step 2: 运行确认失败。**
- [ ] **Step 3: 实现主进程校验与渲染端传参。**
- [ ] **Step 4: 运行通过，再跑 `npm run check`（含 renderer tsconfig）。**
- [ ] **Step 5: 提交** `fix(review): 人工行程编辑校验 spotId，防止下标错位`

### Task 8: 全量验收

- [ ] **Step 1:** `npm run check`，预期两套 tsconfig 都无错误。
- [ ] **Step 2:** `npm run test:changed`，预期收据显示 5 项正向全部到达 `waiting_approval` 并生成新的 `pendingApproval`，20 项负向全部被门禁拦住，0 失败、0 skip。收据不足 25 项时补跑 `npm run test:e2e`。
- [ ] **Step 3:** `npm run build` 成功。
- [ ] **Step 4:** `git diff --name-only main | xargs wc -l`，确认没有文件超过 350 行。
- [ ] **Step 5:** 在 `ARCHITECTURE.md` 的「行程 POI」一节补一行：spotId 是景点身份，名称比较统一用 `poiNameKey`。然后提交 `docs: 记录景点 spotId 身份约定`。
