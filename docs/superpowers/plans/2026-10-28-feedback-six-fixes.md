# 六项运营反馈优化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复酒店、图片、子产品的录入失败与"假成功"，并提升行程特色、改天数、私家团小标题三项的内容质量与规则。

**Architecture:** 每项反馈对应一个任务、一次提交。第一批（T1–T3）只改失败判定与状态展示；第二批（T4–T6）改生成规则与录入流程。所有 VBK 写入仍限于安全录入阶段，不提审、不发布。

**Tech Stack:** TypeScript、Electron main、node:test（`node --import tsx --test`）、Playwright 接口会话。

**Spec:** 本计划依据 2026-10-28 对话中确认的 Q1–Q36，结论汇总见下方"已确认决策"。VBK 实测证据：`/tmp/vbk-days-probe/probe-log.jsonl`，记忆 `vbk-resize-tour-daily-info`。

## 已确认决策（spec 摘要）

- 失败处理：酒店、图片失败时停下标红；子产品失败可以跳过，但显示黄色"已跳过"并写明原因，在汇总里单独列出。
- 行程特色：卖点优先从 `userIdea` 提取；每条推荐理由至少有一个具体景点名或数字，三条不重复；不合格就重试，仍不合格停下标红；去掉泛化兜底文案，超长时只截短。
- 改天数（增天、减天）：去掉本地天数锁；基本信息用 `resizeTourDailyInfo="F"` 保存，再写完整 N 天草稿，最后回读核对；写入报错或回读天数不一致，就转新建产品；原产品上重录时同步子产品，新建产品时重新生成子产品；`active=D`（VBK 显示"无效·下线"）视为未发布。
- 私家团小标题：格式 `前缀｜内容`，整行不超过 24 字（首日【出发地-城市】前缀也算在内）；最多 3 个景点，城市之间用 `-`，同城景点之间用 `·`；前缀只能从 专车服务/专车接机/专车接站/专车送机/专车送站/自由活动 中选；超长先让 AI 重写 1 次，再从末尾删景点；用车卡片只取"｜"后的内容；自由活动日不生成用车卡片；其他团型不变。

## Global Constraints

- 每个文件 ≤ 350 行（含空行、注释），改完自查 `wc -l`；超出就按职责拆分，用 barrel 保持调用方路径不变。
- 代码里任何地方禁止出现 `resizeTourDailyInfo: "T"`。
- 不调用任何提审、发布、上线、激活接口；测试禁止真实写入携程。
- 地点字段使用无行政尾缀的短名（「汕头」「四川」）。
- 每个任务完成后运行 `npm test` 和 `npm run check`；全部任务完成后运行 `npm run test:changed`，确认 5 个正向 case 加 20 个负向 case 共 25 项全部执行并通过。
- 提交信息用中文，结尾附 `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`；不要提交 `tmp-*`、`/tmp` 下的调试脚本。

## Review Focus

1. 私家团小标题从末尾删景点时，原路线途经节点（`isPersistedRouteTravelNode`）必须保留，因为下游靠标题识别途经地（提交 2547f06c）。测试写在 T6。
2. `hotelCity="潮汕"` 改写成汕头后，`verifiedRouteOvernightCity` 如果仍返回「潮汕」，不能再报"与原路线落点不一致"。测试写在 T1。
3. 去掉占位封面后，未登录 VBK 时规划后处理不写占位图、不抛异常，readiness 里出现"封面缺失"的阻塞项。测试写在 T2。
4. 天数变化后，basic 阶段指纹失效，从 basic 起重跑；子产品天数和母产品不一致时，不能走"已启用直接 return"。测试写在 T5。
5. 推荐理由具体性校验：景点名带「·」、英文或数字（如「5A」「G318」）时不误判；三条只是共用景点名时不算重复。测试写在 T4。

---

### Task 1: 酒店住宿城市补全

**Files:**
- Modify: `src/shared/platform-hotel-rules.ts:44-60`（`normalisePlatformHotelProduct` 里城市候选要经过别名改写）
- Modify: `src/main/automation/ctrip/hotel-rule-api.ts:89-98`（`hotelRuleProvince`）
- Modify: `src/main/automation/ctrip/hotel-resource-api.ts:80-87`（缺少末尾空段时的处理）
- Test: `test/resources/platform-hotel-rules.test.ts`、`test/resources/cross-province-hotel-rule-api.test.ts`、`test/resources/hotel-resource-layout-api.test.ts`

**Interfaces:**
- Produces: `hotelRuleProvince(product: any, cityName: string, dayNumbers?: number[]): string | undefined`，导出给测试用。

- [ ] **Step 1: 写失败测试**
  - `platform-hotel-rules.test.ts` 新增 `"旅游区住宿城市改写为行政城市"`：`hotelCity: "潮汕"`，经过 `normalisePlatformHotelProduct` 后，`platformHotelStayGroups` 返回 `[{ cityName: "汕头", nights: N }]`，不抛错。再加一例：`verifiedRouteOvernightCity` 返回「潮汕」时也不报不一致（Review Focus 2）。
  - `cross-province-hotel-rule-api.test.ts` 新增 `"住宿城市当天无景点时用当天和次日景点推断省份"`：第 2 晚住「西宁」，西宁没有景点；第 2 天和第 3 天的景点都属于青海；全程另有甘肃景点。断言 `hotelRuleProvince(product, "西宁", [2]) === "青海"`。
  - `hotel-resource-layout-api.test.ts` 新增 `"缺少末尾空段时先补空段再新增住宿段"`：fake page 返回的段列表里没有 0 晚可删除的末尾段。断言先发出一次保存（`segmentId: 0`，`stayNights: 0`，`deleteable: true`），再按原逻辑新增住宿段；最终回读 `assertLodgingPrefix` 通过。
- [ ] **Step 2: 运行，确认失败**：`node --import tsx --test test/resources/platform-hotel-rules.test.ts test/resources/cross-province-hotel-rule-api.test.ts test/resources/hotel-resource-layout-api.test.ts`。预期：上面 3 个新用例失败。
- [ ] **Step 3: 实现**
  - `normalisePlatformHotelProduct`：`savedCity`、`routeCity` 和最终 `city` 都先过 `toWritableAdministrativeCityName`，再取短名。
  - `hotelRuleProvince`：原有两条规则都没得出结果时，取 `dayNumbers` 中各天及其次日的 `spots[].province`；去重后恰好 1 个就返回它。调用处 `provinceForCity` 和 `assertHotelRulesLayout` 传入住宿组的 `dayNumbers`。
  - `normalizeHotelResourceLayout`：末尾段不满足"0 晚 + deleteable"时，以 `segments.at(-1)` 为模板调用 `buildLodgingResourceSegment` 的同类构造，规则如下：`segmentId: 0`；`segmentNumber` 取现有最大值加 1；`stayNights/min/max` 都为 0；`deleteable: true`；不带资源组和房间。保存后重新读取段列表，然后继续原循环。如果补段后仍拿不到可用末尾段，抛错 `"VBK 资源配置无法补出末尾空段，请在资源配置页手动添加一个空行程段后重试"`。
  - `platformHotelStayGroups` 里"缺少住宿城市"和"不是可写行政城市"两条报错，末尾统一追加 `"；请在行程规划中人工指定当晚住宿城市"`。
- [ ] **Step 4: 运行，确认通过**：命令同 Step 2，再跑 `npm test` 和 `npm run check`。
- [ ] **Step 5: 提交**：`fix(hotel): 住宿城市别名改写、相邻日推断省份与末尾空段补建`

> 风险：补建末尾空段的协议目前只有"新增住宿段"的抓包证据。错误协议会被随后的段回读拦下并报错，不会被当成成功。

### Task 2: 图片检索与封面失败处理

**Files:**
- Modify: `src/main/operations/cover-auto-fill/apply.ts:118`（传入 logger）、`:209-222`（不再写占位图）
- Modify: `src/main/ipc/planning-ipc/postprocess.ts:32-39`（未登录时不写占位图）
- Modify: `src/main/infrastructure/ctrip-library-search/images.ts:88`（getImageInfo 批量失败后逐张重试）
- Modify: `src/main/automation/ctrip/presentation/presentation/save.ts:96-104`（`imageWarnings` 写进运行日志）
- Test: `test/resources/cover-auto-fill.test.ts`、`test/resources/cover-fallback-handoff.test.ts`、`test/infrastructure/ctrip-library-search.test.ts`、`test/automation/presentation-image-best-effort.test.ts`

**Interfaces:**
- Produces: `coverSearchLogger: CoverPlaceSearchLogger`，在 `src/infrastructure/cover-place-search-logger.ts` 里新增导出，把每个事件以 `logInfo("[cover-search]", event)` 输出。

- [ ] **Step 1: 写失败测试**
  - `cover-auto-fill.test.ts`：`"无合格候选时不写占位图并返回阻塞原因"`。断言 `outcome.written === false`，`nextProduct.presentation.coverFallback === undefined`，`outcome.reason` 包含景点关键词列表。
  - `cover-fallback-handoff.test.ts`：把原来"占位图可进入审批"的断言改成：没有封面时 readiness 的 `ready === false`，并且存在 label 含"封面"的 gap（Review Focus 3）。
  - `ctrip-library-search.test.ts`：`"getImageInfo 批量失败时逐张重试，只丢失败的图"`。fake 浏览器让批量请求抛错、逐张请求只有 id=2 抛错。断言 candidates 里有 id 1 和 3。
  - `presentation-image-best-effort.test.ts`：景点图绑定失败时，日志收到一条含 `imageId` 的 warn。
- [ ] **Step 2: 运行，确认失败**：`node --import tsx --test` 跑上面 4 个文件。
- [ ] **Step 3: 实现**
  - `apply.ts`：调用 `searchCtripLibraryImages(args.page, keyword, { logger: coverSearchLogger })`。`!primary` 分支直接返回 `{ nextProduct: product, outcome: { written: false, reason } }`；`reason` 沿用现有中文文案，把"已设置…占位图"改成"请重试或人工上传/选择图库图片"。
  - `postprocess.ts`：未登录分支只 `logInfo` 后 `return`，不调用 `applyCoverFallback`。`applyCoverFallback` 保留不删，已有产品的历史占位数据仍按现有逻辑读取。
  - `images.ts`：`fetchCtripImageInfoMap` 抛错后，对 `imageIds` 逐个调用；单张失败只记一条 logger 事件 `image-info-failed`，其余照常拼装。
  - `save.ts`：存在 `failures` 时，调用 `logWarn("[presentation] 景点图绑定失败", { failures })`。
- [ ] **Step 4: 运行，确认通过**：同 Step 2，再跑 `npm test`、`npm run check`。
- [ ] **Step 5: 提交**：`fix(cover): 打开图库检索日志、封面无图时停下、单图失败不丢整组`

> 每日行程的景点节点写图片（`info-builders/poi.ts:46` 的 `images: []`）这次不做。已只读扫描 5 个产品的 89 个 POI 节点，没有一个带图片，拿不到平台接受的字段格式。需要运营在 VBK 后台给任一草稿的某个景点节点手动加一张图，回读得到格式后，再单独开一个任务。

### Task 3: 子产品状态如实显示

**Files:**
- Modify: `src/shared/traffic-resource-status.ts:10`（销售班期缺失不再算作"平台无资源"）
- Create: `src/shared/traffic-skip-reason.ts`
- Modify: `src/main/automation/ctrip/traffic-line/child-failure.ts:35-38`
- Modify: `src/renderer/**/helpers/traffic-line-child-status.ts`（失败也显示"已跳过"，并带原因）
- Modify: `src/main/application/product-execution-service.ts:86-90`（汇总文案）
- Modify: `src/main/automation/ctrip/traffic-line/run-phase.ts:137`（0 个子产品时的日志）
- Test: `test/automation/traffic-line-core.test.ts:417`、`test/agent/traffic-children-approval.test.ts`，新建 `test/shared/traffic-skip-reason.test.ts`

**Interfaces:**
- Produces: `type TrafficSkipReason = "platform_unavailable" | "local_inventory_missing" | "child_failed"`；`trafficSkipReason(reason: string, variant?: TrafficLineVariant): TrafficSkipReason`；`TRAFFIC_SKIP_LABELS: Record<TrafficSkipReason, string>`，取值分别为 `"平台当前无可售交通资源"`、`"本地未配置销售班期，请在价格库存班期补充后重试"`、`"子产品录入失败，已跳过"`。
- Produces: `trafficSummaryMessage(product: ProductDetail, snapshot?: AgentSnapshot): string`。

- [ ] **Step 1: 写失败测试**
  - `traffic-skip-reason.test.ts`：`"没有可用于交通资源核验的销售班期"` 归为 `local_inventory_missing`，`"当前无可售资源"` 归为 `platform_unavailable`，其他文案归为 `child_failed`。
  - 修改 `traffic-line-core.test.ts:417`：断言"没有销售班期"不再被 `isUnavailableTrafficResourceFailure` 认定为平台无资源，但 `trafficLineFailureProgress` 仍然 `skipped: true`。
  - `traffic-children-approval.test.ts`：
    - 未勾选生成子产品、母产品已核验时，`trafficSummaryMessage` 返回 `"母产品草稿已通过核验；本次未生成子产品"`；
    - 两个子产品中一个跳过时，返回值包含 `"已跳过 1 个子产品："` 和对应的 label。
  - 渲染状态：带 `failureReason` 的子产品，`trafficLineChildStatus` 返回 `"skipped"`；endpoint hint 里包含原因。
- [ ] **Step 2: 运行，确认失败**。
- [ ] **Step 3: 实现**
  - 从 `isUnavailableTrafficResourceFailure` 里删掉销售班期那条正则。
  - `trafficLineFailureProgress` 固定 `skipped: true`，并新增字段 `skipReason: trafficSkipReason(reason, variant)`。字段要加进 `TrafficLineChildProgress` 类型。`failedStage` 的保留逻辑不变，重试仍可用。
  - `hasPendingTraffic` 把 `skipped` 的子产品视为已处理，保持母产品可完成。
  - `product-execution-service.ts:89` 的 `message` 改为调用 `trafficSummaryMessage`。
  - `run-phase.ts:137`：子产品数为 0 时，日志改为 `"本次未生成交通子产品"`。
- [ ] **Step 4: 运行，确认通过**，再跑 `npm test`、`npm run check`。
- [ ] **Step 5: 提交**：`fix(traffic): 子产品跳过如实标注原因，区分缺班期与平台无资源`

### Task 4: 行程特色具体化，去掉泛化兜底

**Files:**
- Create: `src/main/planning/validation/recommendation-quality.ts`
- Modify: `src/main/planning/validation/validators-basic.ts:84-111`（接入质量校验）
- Modify: `src/main/planning/adapters/planning-prompt.ts:41-50`（presentation 规则）
- Modify: `src/main/planning/vbk-recommendation-length.ts:45-83`（`safeFallback` 改为抛错）
- Modify: `src/main/planning/stage-deterministic-completion.ts:80-87`、`src/main/agent/presentation-deterministic-repair.ts:21-26`（不再调用 `presentationFallback`）
- Modify: `src/main/planning/product-generation/service.ts:75-80`（presentation 阶段失败不再转本地补全）
- Modify: `src/main/minimax/minimax-constants/prompts.ts:143-144`（示例换成具体的写法）
- Test: 新建 `test/planning/recommendation-quality.test.ts`；更新 `test/planning/recommendation-length.test.ts`、`test/agent/presentation-recommendations.test.ts`

**Interfaces:**
- Produces: `recommendationQualityProblems(product: Record<string, unknown>, texts: string[]): string[]`。每条问题写明是第几条、什么原因，供重试时作为 `rejectedReason` 回传给模型。

- [ ] **Step 1: 写失败测试** `recommendation-quality.test.ts`
  - 第 1 条是"行程安排清晰，游览节奏舒适"，返回的问题里包含 `"第1条缺少具体景点名或数字"`。
  - 第 2 条含景点名「布达拉宫·大昭寺」或「G318」，不报问题（Review Focus 5）。
  - 两条字符二元组 Jaccard 相似度 ≥ 0.6 时报 `"第1条与第2条内容重复"`；两条只共用一个景点名时不报。
  - `fitVbkRecommendationText` 遇到超长且无法按分句截短的文本时抛错，不再返回 `CATEGORY_FALLBACKS` 里的文案。
- [ ] **Step 2: 运行，确认失败**。
- [ ] **Step 3: 实现**
  - 具体名词来源：行程里各天的 `spots[].poiName` 和 `name`、`basicInfo.meetingCity`、`hotelCity`，外加正则 `/\d/`。比较前去掉空格和「·」。
  - `validators-basic.ts` 把这里返回的问题追加到 `reasons`，沿用现有的阶段重试与原因回传机制；重试上限用现有的 `PLANNING_STAGE_RETRY_LIMIT`，满足"最多重试 2 次"。
  - planning-prompt presentation 规则新增一条，原文：`"10. 推荐理由与产品特色优先提炼用户原文（userIdea）中的卖点；每条至少包含一个本行程真实景点名、城市名或具体数字；三条分别写不同维度，禁止"节奏舒适""安排清晰"等空泛表述。"`
  - 去掉兜底：`stage-deterministic-completion` 和 `presentation-deterministic-repair` 遇到不合格时保留 gap，状态为 `needs_user`。`service.ts` 的 catch 中去掉 `"presentation"`，只保留 `commercial`。`presentationFallback` 删掉之后若已无调用方，连同它的测试一起删除。
  - `CATEGORY_FALLBACKS` 和 `safeFallback` 删除；无法截短时抛 `"推荐理由超过 84 平台字符且无法按分句截短"`。
- [ ] **Step 4: 运行，确认通过**，再跑 `npm test`、`npm run check`。
- [ ] **Step 5: 提交**：`feat(presentation): 推荐理由具体性校验，去除泛化兜底文案`

### Task 5: 改天数可用，失败转新建产品

**Files:**
- Modify: `src/main/agent/user-instruction-repair.ts:60`（远端已有草稿时也允许改天数）
- Create: `src/shared/vbk-publication.ts`
- Modify: `src/main/automation/ctrip/itinerary-review/evidence.ts:184`、`src/main/automation/ctrip/itinerary-review/unlock.ts:203`、`src/main/automation/automation.main/automation.main.replace-locked-draft.ts:31-46`、`src/shared/itinerary-review-unlock.ts:69`
- Create: `src/main/automation/automation.main/duration-change-replacement.ts`
- Modify: `src/main/automation/ctrip/itinerary-api/readback.ts:63-65`（天数不一致时抛带类型的错误）
- Modify: `src/main/automation/automation.main/automation.main.run-one.ts`（捕获该错误后转新建产品，只做一次）
- Modify: `src/main/automation/ctrip/traffic-line/main/process-target.ts:119-127`、`src/main/automation/ctrip/traffic-line/itinerary-materialization.ts:41-48`（子产品同步母产品行程）
- Test: `test/agent/user-instruction-repair.test.ts:89`；新建 `test/automation/resize-tour-daily-info-guard.test.ts`、`test/automation/vbk-publication.test.ts`、`test/automation/duration-change-replacement.test.ts`；更新 `test/automation/traffic-line-backfill.test.ts`

**Interfaces:**
- Produces: `isUnpublishedActive(value: unknown): boolean`，`"F"` 和 `"D"` 返回 true。`ItineraryReviewUnlock.publication.active` 的类型改为 `"F" | "D"`。
- Produces: `class DurationChangeRejectedError extends Error { expectedDays: number; actualDays: number }`，从 `readback.ts` 导出。
- Produces: `prepareDurationChangeReplacement(product: ProductDetail): { previousProductId: string }`。它只在本地解绑，不碰远端；解绑后由同一轮运行从第一个录入阶段新建产品重录。

- [ ] **Step 1: 写失败测试**
  - `user-instruction-repair.test.ts:89` 改为：已有 `productId` 时，"改成4天3晚"会生效；运行中（status 为 `running`）仍返回 undefined。
  - `resize-tour-daily-info-guard.test.ts`：递归读取 `src/`，断言没有任何文件匹配 `/resizeTourDailyInfo\s*:\s*["']T["']/`。
  - `vbk-publication.test.ts`：`isUnpublishedActive("D") === true`、`("T") === false`；`assertRemoteDraftCanBeReplaced` 对 `active: "D"`、`auditStatus: "N"` 的产品不抛错。
  - `duration-change-replacement.test.ts`：readback 抛出 `DurationChangeRejectedError` 后，`setProductLifecycle` 被调用并传入 `{ productId: null, basicInfoSaved: false }`；消息里包含旧 VBK ID 和 `"请在 VBK 后台手动下线或删除"`；同一轮运行里第二次出现该错误时不再转新建，直接失败。
  - 天数变化后，`staleCompletedEntryPhases` 返回的第一个阶段是 `basic`（Review Focus 4）。
  - `traffic-line-backfill.test.ts`：已启用子产品的行程天数和母产品不同时，不走提前 return，并按母产品的 `tourDailyDescriptions` 重建子产品行程，再合并首末交通节点。
- [ ] **Step 2: 运行，确认失败**。
- [ ] **Step 3: 实现**
  - `user-instruction-repair.ts:60`：条件只保留 `detail.automation?.status === "running"`。
  - 上述 4 处 `active !== "F"` 的判断都改用 `isUnpublishedActive`；`isonline` 和 `releaseActive` 仍要求是 `"F"`。
  - `readback.ts`：天数不一致时抛 `DurationChangeRejectedError`。`run-one` 在 basic 或 itinerary 阶段捕获它，或捕获到 VBK 写入报错且错误信息含"天数"时，调用 `prepareDurationChangeReplacement`，然后从第一个阶段重跑；每轮运行最多一次。新产品上的子产品由正常的 trafficLine 阶段重新生成。
  - 子产品同步：`process-target` 读取母产品当前行程的天数，和子产品不一致时跳过提前 return。`itinerary-materialization` 增加可选参数 `parentDescriptions`，有值时用它作为行程底稿。同步失败沿用 T3 的跳过规则。
- [ ] **Step 4: 运行，确认通过**，再跑 `npm test`、`npm run check`。
- [ ] **Step 5: 提交**：`feat(itinerary): 允许录入后改天数，天数被拒时转新建产品，子产品同步母产品行程`

> 已有的天数改写只处理 `supplierProductName`、`subtitle`、`packageName`。主标题由 basic 阶段按天数重新拼接（`basic-info/api.ts:196`），不需要另外改。

### Task 6: 私家团每日小标题模板

**Files:**
- Create: `src/shared/private-tour-day-title.ts`
- Modify: `src/shared/itinerary-day-title.ts:15-18`（私家团的预算按 24 字算）
- Modify: `src/main/planning/itinerary-day-titles.ts`（请求里带上团型；校验和兜底按私家团规则）
- Modify: `src/main/minimax/itinerary-day-title-generator.ts:9-13`（私家团提示词）
- Modify: `src/main/planning/adapters/planning-prompt.ts:39`（规则 8a 增加私家团格式）
- Modify: `src/main/automation/ctrip/itinerary-api/itinerary-transform.ts:146`、`src/shared/itinerary-service-copy.ts`（用车卡片）
- Test: 新建 `test/planning/private-tour-day-title.test.ts`；更新 `test/planning/itinerary-day-titles.test.ts`

**Interfaces:**
- Produces（`private-tour-day-title.ts`）：
  - `PRIVATE_TOUR_DAY_TITLE_PREFIXES = ["专车服务", "专车接机", "专车接站", "专车送机", "专车送站", "自由活动"] as const`
  - `PRIVATE_TOUR_DAY_TITLE_MAX_LENGTH = 24`
  - `privateTourDayTitleProblem(title: string, budget: number): string | undefined`
  - `fitPrivateTourDayTitle(title: string, budget: number, keep: string[]): string`。`keep` 是必须保留的途经节点。
  - `privateTourDayTitleContent(title: string): string`：返回"｜"之后的内容；没有"｜"时原样返回。
  - `isFreeActivityDayTitle(title: string): boolean`
- Consumes: `isPrivateTour(product)`。`src/shared/product-form.ts` 里有就复用，没有就在新文件里按 `sales.productForm === "privateTour"` 判断。

- [ ] **Step 1: 写失败测试** `private-tour-day-title.test.ts`
  - 不报问题：`"专车服务｜故宫·景山公园·什刹海"`。
  - 报问题：`"包车服务｜故宫"`（前缀不在白名单）；含 emoji、【】（首日【出发地-城市】前缀除外）、"+"、"→"的标题；4 个景点的标题；首日 `"【出发地-哈尔滨】专车接机｜抵达哈尔滨·入住酒店"` 正好 24 字不报，再多 1 个字就报。
  - `fitPrivateTourDayTitle("专车服务｜大理-丽江·双廊古镇·束河古镇·玉龙雪山", 20, ["丽江"])`：从末尾删景点，结果不超过 20 字，保留"专车服务｜"、第一个内容节点和「丽江」（Review Focus 1）。
  - `privateTourDayTitleContent("专车服务｜故宫·天坛") === "故宫·天坛"`。
  - `itinerary-day-titles.test.ts` 新增：私家团的请求 `maxLength` 等于 `24 - 首日前缀长度`；跟团游的请求仍是 70。
  - 行程转换：私家团包车日的用车卡片文案为 `"故宫·天坛，全天用车"`；标题以"自由活动｜"开头的那天没有用车卡片。
- [ ] **Step 2: 运行，确认失败**。
- [ ] **Step 3: 实现**
  - `itineraryDayTitleBudget`：私家团用 `PRIVATE_TOUR_DAY_TITLE_MAX_LENGTH - 前缀长度`。写入时的 70 字拦截保持不变。
  - `ItineraryDayTitleRequest` 新增 `format?: "privateTour"`。私家团的 `requiredNames` 只放第一个景点和 `routeNodes`，其余景点作为可选项，字段名 `optionalNames`。`titleProblem` 对私家团先调 `privateTourDayTitleProblem`，再检查必含项和是否串天。
  - 生成提示词在 `format` 为私家团时追加，原文：`"私家团标题格式为「前缀｜当天内容」，前缀只能从 专车服务、专车接机、专车接站、专车送机、专车送站、自由活动 中选；城市之间用「-」，同城景点之间用「·」，最多 3 个景点；不得使用 emoji、括号、+、→、营销词。"`
  - AI 重试仍不合格时，`ensureDayTitleFits` 对私家团调用 `fitPrivateTourDayTitle`；结果没有合法前缀时，补成 `专车服务｜`，或者在当天没有景点、没有途经节点时补成 `自由活动｜`。
  - `itinerary-transform.ts:146`：私家团的用车卡片取 `privateTourDayTitleContent(day.title)`；`isFreeActivityDayTitle` 为 true 时不放用车卡片。其他团型维持现状。
- [ ] **Step 4: 运行，确认通过**，再跑 `npm test`、`npm run check`。
- [ ] **Step 5: 提交**：`feat(itinerary): 私家团每日小标题模板「前缀｜内容」与 24 字上限`

### Task 7: 全量回归

> 风险：T2（去掉占位封面）和 T4（去掉推荐理由兜底）会改变部分回放路径。如果某个正向 case 原本靠占位图或兜底文案才走到 `waiting_approval`，回归会失败。遇到这种情况要停下报告，不能放宽门禁，也不能改回放基线。

- [ ] **Step 1**：运行 `npm run test:changed`，确认收据里 5 个正向、20 个负向各执行一次并全部通过；漏收集就补跑 `npm run test:e2e`。
- [ ] **Step 2**：运行 `npm run check` 和构建（`npm run build`，脚本以 `package.json` 为准）。
- [ ] **Step 3**：对所有改动文件跑 `wc -l`，确认都 ≤ 350 行。
- [ ] **Step 4**：报告 25 项的执行数和结果、各项提交的哈希，以及待办：景点节点图片还缺字段格式证据；80293306（已审核产品）的改天数实测暂缓。
