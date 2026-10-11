# 架构问题核验（2026-10-11）

范围：当前工作区源码，包括已有未提交重构。初次仅核验文档；后续按用户指示处理 5 项失败，修改归一化实现及对应测试，不操作业务数据。
结论按当前源码和本地验证区分；不推断已安装版本或生产版本。

## 1. 旧文档“审计发现与调整”逐项复核

| 原问题 | 是否仍存在 | 当前证据 |
| --- | --- | --- |
| planning/data 反向依赖 automation 工作流 | 在所检查范围未发现 | `architecture-boundaries.test.ts` 扫描这两层，通过 |
| schemas 与 tool-schema 循环 | 原问题已解决 | 两者通过 `stage-contract` 共享；拆分后的 schema 文件也纳入检查 |
| AI 与 planning 无共同互斥 | 原问题已解决 | 入口现统一委托 Agent；写工具包装使用 `ProductWorkflowCoordinator`，互斥及异常释放测试通过 |
| AI 网络返回后用旧快照覆盖产品 | 原问题已解决，限所测入口 | `ProductMutationService.applyAiPatch` 提交前重读；相应测试通过。不能据此断言所有异步调用方都无竞态 |
| 产品写入/广播散落 | 已建立公共入口，但不是所有写入都只经过一个类 | mutation 保存后重读广播；人工字段与 research 使用数据库原子写入等专门路径 |
| IPC sender 校验依赖人工记忆 | 正式 registrar 已使用安全门面 | 当前 IPC 源码使用 `secureIpcMain`；来源策略、覆盖测试通过 |
| IPC 只有 TypeScript 类型 | 原问题已解决，限已有覆盖 | 安全门面调用 `validateIpcArguments`；输入拒绝与通道覆盖测试通过 |
| Renderer 单一大状态袋 | 已分域，恢复副作用仍可优化 | `state/domains` 已拆；`derived.ts` 271 行，仍处理初始化、订阅、产品切换与恢复 |
| basic-info 混合封面搜索等职责 | 已存在职责拆分 | `renderer/app/views/workspace/basic-info-row-shell.tsx` 与封面相关模块分开；本次未进行 UI 交互验收 |
| 文档旧路径与存储描述 | 核验前仍存在文档漂移 | 旧主图与后附流程重复，并把旧规划入口、交通完成条件画成当前事实；本次已重写 |

“已解决”针对表中具体历史问题；通过静态检查不代表所有调用链、所有并发场景都经过验证。

## 2. 旧文档“仍需关注的风险”复核

| 旧描述 | 当前判定 | 证据与后续关注 |
| --- | --- | --- |
| `vbk-browser.ts` 仍偏大 | 已过时 | 主文件 174 行；accounts 183、page-driver 131、view-manager 178 行，已按职责拆分 |
| MiniMax 解析与图库协议需要拆分 | 已拆分 | 所查 `minimax-parsing*.ts` 最大 288 行，`ctrip-library-protocol.ts` 55 行 |
| `derived.ts` 恢复副作用集中 | 仍存在维护复杂度 | 文件 271 行，另有 planning-recovery、collection-live-updates、browser/product derived；复杂度仍需在相关改动时评估 |
| Legacy AI 与 staged planning 两套正式协议/循环 | 描述部分过时 | `main-ipc.ts` 只注册 planning-v2；`ai:send` 委托 Agent。旧编排代码仍在，patch 与模块生成协议仍共存，但不能画成两条正式调度循环 |
| VBK 页面/API/账号配置漂移 | 仍存在外部依赖风险 | 当前执行继续依赖会话请求、页面与平台业务响应；本次没有真实平台验收 |
| 日志无时间 TTL、无独立审计导出策略 | 需要拆开描述 | 无 TTL 仍成立；已有 CSV 导出及再次脱敏。长期保留、不可变归档等独立审计策略本次未发现 |

没有按时间保留策略属于当前能力边界；尚无证据表明它已经造成运行故障。

## 3. 其它过时或过强的描述

1. 正式规划入口是 Agent 持久化调度，`ProductGenerationService` 是生成用例，`planning_generation` 不是当前正式入口唯一的规划事实。
2. `planning-state-projection` 转换节点进度，不代表 accepted 内容或准备就绪；准备度由当前产品检查决定。
3. `remoteProducts` 在当前装配中使用 `createLocalProductService`。产品本地保存，历史云端只读迁入；不能仅凭变量名画成云端产品权威。
4. 原阶段图把 terms 画在资源阶段之前；当前 `draftPhasesFor` 是价格、酒店、车辆之后执行 terms，再执行可选 trafficLine 和 preflight。
5. 母产品成功不要求交通子产品全成功。`optional-traffic-phase.ts` 保留失败继续母产品预检；`isVerifiedAutomationComplete` 排除 trafficLine，子产品证据必须单独报告。
6. 授权不是“任意产品指纹变化都重新确认”：`integration-guard.ts` 对同意图的确定性执行中变更有明确例外，账号、范围和运行守卫继续生效。
7. `AgentSnapshotManager.validApproval` 获取当前授权；平台调用前的完整授权核验由 `assertAgentWriteAuthorized` 等守卫承担。
8. 旧验收文档把 `npm test` 称为全量回归。当前命令含 `--changed`；全量测试入口为 `npm run test:all`。
9. 旧 `ARCHITECTURE.md` 为 586 行，违反新的 350 行上限。本次压缩为总览，详细核验放在本文件；已有三个模块文档保留原样。

## 4. 初次核验与失败定位（修复前）

类型检查：`npm run check` 通过。

第一组 8 个文件共 34 项：33 通过、1 失败。覆盖架构边界、IPC 覆盖/参数/来源、产品互斥、产品写入、快照脱敏和日志持久化/CSV 脱敏。

第二组检查以下 10 个文件，发现 4 项失败，均在 `product-patch.test.ts`：

- `planning/main-ipc-contracts.test.ts`
- `planning/product-generation-service.test.ts`
- `planning/planning-state-projection.test.ts`
- `planning/preparation-policy.test.ts`
- `agent/integration-gates-preparation.test.ts`
- `automation/automation-runtime.test.ts`
- `automation/automation-workflow-plan.test.ts`
- `automation/optional-traffic-phase.test.ts`
- `resources/resource-resolution-boundaries.test.ts`
- `products/product-patch.test.ts`

### 失败定位

| 测试 | 当前差异 | 判定 |
| --- | --- | --- |
| `application/product-mutation-service.test.ts:170` | “历史接送”不再留在 spots，测试取到 undefined，仍期待 poiId=null | 当前服务安排归一化将其转为交通活动；测试仍按旧景点位置断言 |
| `products/product-patch.test.ts:48` | operations 多出 `hotelFallbackPolicy.allowDowngrade=true` | 默认策略与旧对象精确断言不一致 |
| `products/product-patch.test.ts:259` | 午餐不再出现在 activities | 当前归一化使用餐食字段；测试仍期待餐食活动 |
| `products/product-patch.test.ts:295` | activities 数量为 1，测试期待 2 | 服务活动迁移影响旧数量断言 |
| `products/product-patch.test.ts:414` | 接团服务不再出现在 spots | 当前规则将接送转为服务活动；测试仍期待 other 景点 |

上述是失败原因定位，不等于已经修复，也不证明迁移后的所有内容都未丢失。后续应对照现行业务契约核验目标字段和幂等性，再修订实现或测试；本次不通过改预期制造回归全绿。

未运行全量测试、构建、Electron smoke、真实模型调用、真实账号资源查询或 VBK 写入回读。已有模块文档的旧测试计数/隔离构建结果属于其记录日期，不作为本次验证结果。

## 5. 后续修复结果

用户授权处理上述 5 项后，按当前服务安排和酒店默认策略逐项修复：

| 原失败 | 结论 | 处理 |
| --- | --- | --- |
| 历史接送的 POI 断言 | 测试预期过时 | 校验 spots 为空、交通活动保留名称、不携带错误 POI、重复保存不重复 |
| 无效运营占位对象断言 | 测试预期过时 | 接纳默认 hotelFallbackPolicy；增加显式 false 保留与反复归一化检查 |
| 合法餐食活动保留断言 | 旧预期，同时发现实现缺陷 | 餐食应迁入 meals；推迟默认占位填充，保留“午餐自理”等标题与内容 |
| 非法活动筛选数量断言 | 旧预期，同一餐食实现缺陷 | 游览/other 活动保留，餐食移出 activities 后核验实际 meals 内容 |
| 接团 other 景点断言 | 测试预期过时 | 自由活动保留、错误 POI 清空、接团名称与说明进入交通服务活动 |

实现修复位于 `product-normalize/itinerary.ts` 和共享服务安排归一化：先迁移餐食，再为真正缺失的餐食填占位。旧占位允许被明确餐食替换，已有正式餐食保持优先。

先将餐食测试改成正式字段断言，复现实际值仍为占位文案的两项失败，再修复实现并验证通过。修复没有放松活动有效性、原景点 POI、城市或授权规则。

`product-patch.test.ts` 从 418 行拆成原测试入口与邻接 `product-patch/normalization-cases.ts`；原入口导入归一化用例，调用路径和全部原用例保留。

修复后验证：

- 原失败所在测试加服务安排测试：41 项全部通过。
- 重跑第 4 节全部 18 个测试入口，加服务安排测试：140 项全部通过。
- 行程转换、餐食顺序、人工字段及人工删除凭证 4 个下游测试入口：72 项全部通过；与上组共 212 项通过。
- `npm run check` 通过；修改和新增文件全部不超过 350 行；差异格式检查通过。

上述为本地重点回归，没有运行全量测试或真实 VBK 平台验收。

## 6. 后续关注

- 原 5 项失败已处理；涉及同类归一化时继续保留正式字段、内容和幂等性检查。
- 在相关 UI 改动时继续评估恢复副作用的职责拆分；当前文件长度符合上限。
- 日志保留时长、长期审计归档需要明确业务要求后实施。
- 对具体授权产品进行真实平台验收，分别报告母产品和每个交通子产品。
