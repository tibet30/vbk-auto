# 行程规划首轮执行与验证

日期：2026 年 10 月 4 日。状态：首轮实现与本地验证完成；真实应用与 VBK 验收未执行。

用户明确优先解决行程规划卡住。本轮把明确的行程节点连接到现有处理工具，先修复无需人工决策的停点。更完整的后续路线见[稳定性治理方案](./2026-10-04-planning-vbk-reliability-plan.md)。

## 边界

接管本地准备中的三个节点：

| 当前事实 | 下一步 | 成功依据 |
| --- | --- | --- |
| 行程结构缺失或不完整 | 生成 itinerary 模块 | 通过既有 schema 和锁定合同，保存后读回有效行程 |
| 结构已齐，仍有 POI 缺项 | 既有 POI 解析与自修复 | 当前景点绑定、服务活动与研究任务按原业务规则收敛 |
| 行程必要缺项清零，缺住宿候选 | 既有酒店候选解析 | 按日级住宿上下文、晚数与酒店档次保存真实候选 |

不接管缺少城市或天数的基础信息，不猜真实业务选择。图文、商业、封面、车辆和最终确认保留现有路径。复用现有工具执行器、版本校验、产品修改服务和事件持久化，不另建一套录入流程。

只有本轮明确的本地规划请求、正在运行、没有待答/待批准交互、没有不确定写入和已生效录入授权时才自动处理。普通查询、用户主动暂停、废弃任务和审批后的录入流程不被接管。

运行中的业务 SQLite 与 VBK 仅允许读取。本轮不创建、修改或重跑任何真实 VBK 产品，不提交、推送或发布。测试写入仅使用临时隔离数据库。

## 修复前缺陷

1. preparation 的节点顺序把 POI 解析放在行程草稿前。不完整行程叠加旧 POI 研究任务时，系统先处理尚不存在的景点，无法推进。
2. 节点只有提示作用，下一步仍由模型决定，普通节点容易变成“是否继续”或重复工具调用。
3. itinerary 生成结果全部被校验拒绝时，工具仍可能正常返回 accepted/rejected 对象；缺少明确失败及保存后有效结构回读。
4. 旧问题被当前产品字段满足后，core 会暂停并提示“请继续当前方案”，没有接回已获授权的本地规划。
5. 酒店候选的 schema 路径错误可能被归入 POI 节点；合法评分与距离的微小波动可能被当成业务进展，刷新无进展预算。
6. 暂停后的纯进度追问可能被当作新规划指令；修复期间的“是否继续重试”可能再次产生人工停点。

## 进展与恢复规则

以节点、必要缺项、相关锁定字段、活动、研究任务和酒店上下文构成语义进度。诊断文字、时间戳和普通版本更新不算推进。

同一语义状态下同一自动动作最多执行两次。仍未推进时交给模型一次带实际缺口和工具结果的修复机会；修复后仍没有进展，给出准确阻塞及已尝试动作，不生成无效“是否继续”问题。状态真正变化或用户发出新的明确指令后重新计算。

“当前进度如何”“卡在哪”等已识别的纯状态查询仅返回当前持久化事实，不重新生成方案、不清除预算、不让在途结果失效。带“继续、修改、重试”等明确动作的消息仍进入原指令路径。模型修复期间的纯流程确认自动回答；降低酒店档次、删除景点等真实业务变更保留用户选择。

既有问题全部由保存事实解决时，只有合法本地准备请求可自动续跑；未解决的真实问题继续展示。人工素材质量等明确人工阻塞、不确定写入和用户主动暂停保留原边界。

## 预先定义的验收门

| 编号 | 关键用例 | 期望与失败标准 |
| --- | --- | --- |
| P01 | 空行程同时保留旧 POI 研究任务 | 必须先生成 itinerary，随后才解析 POI；先 resolver 或重复处理空结构即失败 |
| P02 | 从 AgentCore 本地准备入口运行结构→POI→酒店 | 自动依节点推进，保存快照后可读回；普通继续类 input_request 为 0；不能越过最后正式确认 |
| P03 | 相同节点重复返回无变化，另只更新诊断/时间/合法酒店评分与距离 | 自动动作最多两次并给一次模型修复，随后具体停止；循环、换参数重置预算或问是否继续均失败 |
| P04 | 有进展、纯进度查询、主动暂停、不确定写、已有授权 | 真进展继续；进度查询不启动规划、不改变预算或关闭在途修复；主动暂停、不确定写、已有授权不被 director 接管 |
| P05 | itinerary 生成全被拒绝；accepted 但回读为空 | 返回真实失败原因，旧合法行程不丢；虚报成功即失败 |
| P06 | 已满足旧 POI/酒店文本问题 | 撤销已解决交互并配对工具结果，本地准备自动续跑；要求继续即失败 |
| P07 | 混合问题、真实选择、普通查询、人工质量阻塞 | 只移除已解决项，未解决业务选择保留；自动代选或恢复禁止状态即失败 |
| P08 | 原城市、天数、景点顺序、二选一和服务活动 | 复用原合同与自修复规则；不得改城市锚点、伪造 POI、丢失全未命中候选或将服务活动当景点 |

测试使用隔离对象、可控模型和资源工具。它们验证生产 Agent 入口和状态转换，但不能替代真实供应商返回、运行中的桌面应用或完整 VBK 录入验收。

## 验证记录

最终冻结后的独立检查结果：

| 检查 | 实际结果 | 证据 |
| --- | --- | --- |
| 全部 `test/agent/*.test.ts` | 365/365 通过，无跳过 | `/tmp/vbk-itinerary-agent-validation-20261004.log` |
| 10 个规划相关测试文件 | 74/74 通过，无跳过 | `/tmp/vbk-itinerary-planning-validation-20261004.log` |
| 主进程与 renderer 类型检查 | `npm run check` 通过 | 最终冻结后重新执行 |
| 生产构建 | `npm run build` 通过 | `/tmp/vbk-itinerary-build-validation-20261004.log`；既有 bundle 大小提示仍在 |
| 任务 diff 与独立审查 | 通过 | 已跟踪任务文件 `git diff --check`；只读审查发现的边界均已补回归 |

P01 至 P08 在各自的本地/隔离范围内通过。P01/P03 由 director 与 AgentCore 回归验证；P02 由隔离 SQLite 三节点流验证；P04 包含暂停、已有审批、不确定写入、状态查询预算及在途模型结果；P05 注入生成全拒绝及 accepted 后保存未生效；P06/P07 验证旧问题续跑、混合问题与真实业务选择；P08 由既有输入合同、自修复、地区与服务活动测试验证。

复现命令（均不访问真实平台）：

```sh
node --import tsx --test --test-concurrency=1 test/agent/*.test.ts
node --import tsx --test --test-concurrency=1 \
  test/planning/grouped-poi-research-task-satisfaction.test.ts \
  test/planning/hotel-preparation-regression.test.ts \
  test/planning/itinerary-input-contract.test.ts \
  test/planning/itinerary-self-repair.test.ts \
  test/planning/itinerary-structure.test.ts \
  test/planning/poi-enrichment-travel-node.test.ts \
  test/planning/poi-replay-region.test.ts \
  test/planning/preparation-completion.test.ts \
  test/planning/research-refresh-issues.test.ts \
  test/planning/runtime-itinerary-write.test.ts
npm run check
npm run build
```

隔离持久化用例经过“结构生成 → POI → 酒店”，保持城市锚点、天数、日序和 5 钻酒店候选，关闭数据库后重新打开仍可读回，Agent 停在最终确认。该用例使用受控模型和资源工具，最终确认门也使用受控依赖，因此只证明本轮节点、执行与持久化连接，不证明完整真实就绪检查或外部资源供应商已验收。

运行中的 Electron 主进程在北京时间 12:29:44 启动，本轮最终源文件在 12:41 后仍有修改。开发 watch 编译不会重启主进程；本次没有停止或重启该应用，不能把构建通过报告为桌面已加载全部修复。

没有本轮真实供应商模型/POI/酒店返回的验收证据，也没有真实 VBK 产品写入、远端回读或全新草稿连续成功计数。普通工具长期不返回、流式存储性能、外部写入对账与跨进程全流程自动恢复仍属于后续工作包。

## 任务文件与后续顺序

本轮源代码改动集中在 `src/main/agent/` 的本地准备编排、输入续跑和进度查询，以及 `src/main/planning/` 的结构与完成核验；复用现有生成、POI、酒店、修改与保存服务。测试集中在 `test/agent/` 和 `test/planning/`。不包含工作区已有的私家团文案、录入 API、封面等其他修改。

关键实现：`preparation-director.ts` 按节点决定下一步；`core-preparation.ts` 管理无进展预算和一次修复；`core-loop.ts` 接入现有执行器；`core-pending-input.ts` 续接已满足问题；`preparation-status-query.ts` 处理只读查询；`integration-generate.ts` 对保存事实做回读；`itinerary-structure.ts` 与 `preparation-completion.ts` 区分结构、POI 和酒店缺项。`core.ts`、`core-tools.ts`、`core-snapshot.ts`、`integration-setup.ts` 和 `types.ts` 完成必要集成。

下一步先在加载新主进程的桌面应用中验收完整行程、简短想法、纯服务活动和 POI 未命中四类本地规划。正式录入确认之前检查保存事实和真实用户问题是否准确。随后再实施工具期限与迟到结果隔离，最后推进 VBK 写入对账与真实未提审草稿验收。完整路线和验收条件仍以配套治理方案及 A 矩阵为准。

## 冻结文件指纹

记录时间：`2026-10-04T12:50:17+08:00`。HEAD 为 `dfdf8d08c01e2bb85b4f57a6ddcc9980ada1214d`，package 版本 `1.1.12`。以下 SHA-256 是最终完整文件指纹，包含原有合法改动，不等于本轮新增 diff；没有提交或覆盖其他工作。

| 任务文件 | SHA-256 |
| --- | --- |
| `src/main/agent/core-loop.ts` | `4aa286c9a8492770a5627dfadcff8ff9c119612e74e1e1fc5e1381edf21a85b0` |
| `src/main/agent/core-snapshot.ts` | `4005c2aeff9dcfd3361570992ce00e10025941cee514658841a3026b57ca2634` |
| `src/main/agent/core-tools.ts` | `6bff0050f7cc761d6ae5e08a1e442c92a0f8b3084165af3d00492669d504bf68` |
| `src/main/agent/core.ts` | `0dbf452431b967f21dbe9651ebc0c5a5cac00088f01d19804c56075257c32c27` |
| `src/main/agent/core-pending-input.ts` | `95c3e38d668eca6ee09221e4e6b316fe8fa4f8b414ba18178d1bf75bd6b762e8` |
| `src/main/agent/core-preparation.ts` | `ca20dc76c07a196dbb75fabcfd833dbf1a1bb83b8dd7800cec732e8b0c03439c` |
| `src/main/agent/preparation-director.ts` | `65ee04893646895846c8a9d712618d9c1e37e1c08a2941a14b21dc314351fa6d` |
| `src/main/agent/preparation-status-query.ts` | `7b080a9ce7b7589e5dcb6a560e44db549e2db1b3b2b655c4035415347bb7a940` |
| `src/main/agent/types.ts` | `a46dbd3f4b100b19933878a9f42340bbb7e1d9bc12a24481e8fc966e90256a43` |
| `src/main/agent/integration-setup.ts` | `d9239faa28e4b5257834f133b7444d301babe04b2eea9b0d3712f9dc571f7389` |
| `src/main/agent/integration-generate.ts` | `26c416bf0f66de45a751622242316fbe15caca26e0f7e2719d2217ebbdc42c45` |
| `src/main/planning/preparation-completion.ts` | `737d4b544b96cb9671c39570f7be9701dc6045857c460e5f7e07fe767d4afe59` |
| `src/main/planning/itinerary-structure.ts` | `4aaeeaecdd35a270fd582e341ad44e85d7421dc009e7f79bfd24858b36558b64` |
| `test/agent/preparation-director.test.ts` | `32d76dc76c7161446258e739f9d35964d3de37cafaa4b20f51095cfc8b70ced2` |
| `test/agent/preparation-autonomous-itinerary.test.ts` | `84e72b260a86a7a4912cdd65114d87a4c862b5c2149a3fe95ba9b2449f371c81` |
| `test/agent/preparation-pending-input-resume.test.ts` | `3c5cf5b71d5da1b0bf015f6a3c4ae5c838c8f861848173578202ed673a3b1d46` |
| `test/agent/itinerary-generation-readback.test.ts` | `4389eca0c6a7665aef729e6c720ef64fe36188d2c2dd10448abffa2d71992cb1` |
| `test/agent/preparation-status-query.test.ts` | `0b149b783fe711bdcb4118fb86d8c7a59e80b1966d1d8502d0ae2131a862604b` |
| `test/agent/preparation-repair-status-query.test.ts` | `84a977aafd63a544881ead728e3f195214e53d07c70b7b43c23ac249ca3b369f` |
| `test/planning/itinerary-structure.test.ts` | `2287bec66af9d12f75968de5def966a137d3e217e13ffe5a21446aeb33c8a385` |
