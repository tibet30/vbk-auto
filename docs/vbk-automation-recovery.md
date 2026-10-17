# VBK 自动录入与恢复

本模块将已确认的产品录入 VBK，并在本地保存可恢复的执行检查点。业务终点为母产品草稿完成权威预检；交通子产品分别以自身最终回读判定完成。

## 代码边界

| 职责 | 入口 |
| --- | --- |
| 对外门面、确认检查与产品互斥 | `src/main/automation/automation.main/automation.main.class.ts` |
| 首次录入、失败续跑、交通补录与完整重录的选择 | `automation.main/runtime/workflow-plan.ts` |
| 全阶段顺序执行 | `automation.main/automation.main.run.ts` |
| 单阶段修复 | `automation.main/automation.main.run-one.ts` |
| 产品壳创建与已有壳只读恢复 | `automation.main.run-sale-control.ts` / `automation.main.recover-shell.ts` |
| 统一日志、持久化、失败与取消收尾 | `automation.main/runtime/session.ts` |
| 每次尝试的授权、页面队列、来源上下文与恢复 | `automation.main/runtime/phase.ts` |
| 基础信息写入与账号固定信息 | `runtime/basic.ts` / `runtime/account.ts` |
| 图文、行程、套餐、价格、资源、条款和预检处理器 | `automation.main.run-one/fill-map.ts` |
| 有界重试、诊断校验与恢复记录 | `recovery/recovery-run.ts` / `recovery-advisor.ts` / `recovery-state.ts` |

上述相对路径均位于 `src/main/automation/`。旧的门面与 helper 导入路径保留。完整录入和单阶段修复使用同一组平台处理器。

## 执行与恢复规则

1. 未创建产品壳时，先执行销售控制。接口返回产品编号后立即落库；后续失败不得丢失该编号。
2. 产品壳创建成功只进入 `queued / review`，不能作为整个产品已保存的依据。
3. 销售控制中断且已有编号时，只读核验已有壳后继续基础信息；缺编号且创建结果不明时阻止重新创建。
4. 只有明确发生在写入前的授权拒绝，才允许重新进入首次创建路径。
5. 普通失败和取消按耐久失败阶段继续；单阶段修复后的 `queued` 记录从待执行阶段继续。完整重录必须有匹配当前执行记录的重录确认。
6. 同一产品只允许一轮录入。交通补录及之后的母产品预检共用同一轮产品锁，不能在两者之间插入其他录入。
7. 平台操作通过注入的共享页面队列执行；每次尝试先检查授权，并在取得页面使用权后再次检查取消信号。
8. 请求客户端连接失败时不落入永久 `running` 状态，保留上一轮检查点。

## 阶段与终态

- 平台处理器自行保存并完成远端回读，正常返回后恢复循环才将阶段标为完成。
- 母产品阶段失败保留 `needs_user`、错误和诊断，产品进入 `blocked`。
- 交通阶段失败保留失败阶段、每个子产品编号、进度及错误，仍允许母产品继续预检。
- 母产品预检通过可以结案母产品阶段，但不修改交通失败状态，不生成子产品的 `verified` 或 `finalReadback`。
- 交通最终资源回读只使用正式 `productSegments`；编辑草稿并存不覆盖正式资源证据。
- 本地保存失败直接终止恢复循环，不交给 AI 触发重复平台写入。
- 再次执行阶段时，旧诊断保留在 `attemptsHistory`；当前轮使用新的尝试数组。
- 每阶段最多尝试三次。诊断动作、说明及人工指令必须通过校验。
- 用户停止后，当前平台请求自然结束；等待中的页面操作、迟到的诊断动作及下一阶段不会继续执行。
- 收尾截图为辅助证据，截图失败仅记警告，不改变已验证的业务结果。

## 行程文案被平台驳回时的自动修复

VBK 只在只读校验步骤（`checkTourDaily` saveType=8/3）判定行程文案非法关键词，草稿保存（saveType=2）不做该判定。因此这类驳回表示「平台只校验、未接受任何写入」，必须就地自愈，而不是留成人工核对的 `uncertain` 写入：

1. `runtime/itinerary-review-unlock.ts` 用 `submitItineraryReviewUnlock` 的 `onWrite` 回调记录本次是否真的派发过远端写入；未派发且无摘要差异时，状态回落为可重试的 `requires_review`（`ITINERARY_REVIEW_REJECTED_WITHOUT_WRITE_MESSAGE`），并抛出 `itineraryReviewValidationOnly` 标记。
2. `itinerary-review-copy-repair.ts` 捕获该标记：用 `itinerary-copy-paths.ts` 定位命中的可见文案路径（天标题 / 天描述 / 景点描述 / 其他与自由活动标题与详情 / 餐食描述），调用行程专属 AI 改写器（`ctx.itineraryCopyRewriter`）定点重写，落库后重跑草稿保存，再重新提交审核；预算 2 轮，用尽如实上抛。
3. 已发生的写入失败（`saveTourDailyDetail` / `saveProductTourInfo` 之后）仍走原来的 `uncertain` 人工核对门禁，不放宽边界。
4. 平台驳回的词写入 `vbk_copy_feedback(module='itinerary')`：既用于提交前的预防性改写，也进入 itinerary 阶段的生成提示，避免重复踩同一个词。
5. 旧版本留下的 `uncertain + 空回执 + 校验驳回文案` 状态，只有在只读核查（`recoverValidationOnlyReview`）用完整方案回读证明远端草稿未变化后，才回落为可重试边界。

## 交通子产品行程文案被平台驳回时的自动修复

子产品行程有自己的写前校验：`ensureTrafficLineItinerary` 的 `校验子产品行程交通`（saveType=8）、`保存子产品行程交通`（saveType=3），以及线路匹配审核的 `线路匹配审核前行程校验`（saveType=3）。这些校验都在写入之前，因此同样必须自愈，而不是把子产品标成未完成：

1. `traffic-line/itinerary-copy-repair.ts` 只识别上述三个标签的 Ack 失败，解析平台点名的词，定位 VBK 行程详情里的自由文案字段（天标题 `dailyDescription` / 天补充说明 `subDesc` / 卡片 `description`、`warmTips`、`specialGift`）。景点、酒店、交通实体身份与结构字段不在可改写范围内。
2. 命中时调用行程专属 AI 改写器（`ctx.itineraryCopyRewriter`，经 `fill-map` 注入为 `copyRepair`）定点重写，就地重试同一校验/保存；`execute` 在第一次真实远端写入前调用 `markWrite`，已派发写入后的失败保持原有失败语义（子产品标记未完成、继续其它子产品）。
3. 线路匹配审核走同一闭环：改写命中载荷后重试同一授权提交，不扩大授权范围。
4. 平台点名的词同样写入 `vbk_copy_feedback(module='itinerary')`，进入行程生成与提交前预防性改写。

## 基本信息文案被平台驳回时的自动修复

`saveProductBaseInfo` 会在 Ack=Failure 详情里点名「操作说明 / 副标题」中的非法关键词（例如 `300019:操作说明存在非法关键词：冈仁波齐`）。DOM 路径原本已有 `repairBasicInfoIllegalKeywords`，但自动录入走 API 路径，此前没有任何修复，阶段直接 `needs_user`：

1. `basic-info-copy-repair.ts` 解析平台点名的字段与词，只用 `stripBasicInfoIllegalKeywords` 清理 `basicInfo.operationNotes` / `basicInfo.subtitle` 这两个自由文案字段，落库后重试保存；预算 3 轮，命中词不在可清理字段内或清理后为空时如实上抛。
2. 接线在 `runtime/basic.ts` 的 API 执行器外层（`runBasicInfoSaveWithCopyRepair`），两种保存路径（供应商编号重算、常规重填）共用。
3. 平台点名的词写入 `vbk_copy_feedback(module='basicInfo')`：既用于下次保存前的预防性清理，也进入 basicInfo 阶段的生成提示。
4. 只清理平台明确点名的词，不改名称、城市、编号、景区 ID 等其他字段，也不放宽回读验收。

## 验证范围

核心测试覆盖恢复决策、共享队列和授权传递、取消检查点、锁释放、诊断历史、产品壳交接及真实临时 SQLite 持久化读回。

自动录入目录的回归还覆盖平台适配器和本地浏览器夹具。Agent 的恢复、完成门及执行计时测试验证调用层衔接；类型检查和构建验证主进程及渲染端集成。

2026-10-11 本次重构验收：相关 933 项测试全部通过，`npm run check`、`npm run build` 和 `git diff --check` 通过；本次改动的 45 个文件均不超过 350 行。

这些验证使用本地数据库和模拟平台响应，不操作已登录账号的真实产品。线上草稿的写入、恢复和回读仍需要针对具体产品执行授权验收。
