# 行程规划与 VBK 录入稳定性调查证据

日期：2026 年 10 月 4 日，北京时间。调查采用当前源码、只读 SQLite、既有执行文档和历史案例。本文保存修复前的调查基线；随后启动的本地行程修复及结果见[首轮执行与验证](./2026-10-04-itinerary-planning-first-pass.md)。未修改真实业务库或 VBK 产品。

配套：[执行方案](./2026-10-04-planning-vbk-reliability-plan.md)、[验收矩阵](./2026-10-04-planning-vbk-reliability-acceptance.md)。本文件用于区分事实、风险和验收缺口，不能替代实施后的验证报告。

## 采样范围

源码基线 HEAD 为 `dfdf8d08`，package 版本 `1.1.12`；调查开始时已有 74 个已跟踪文件修改及多个未跟踪文件。基于整个当前工作区读取，并未将这些改动视为已经运行生效。当前 `npm run check` 执行通过，没有运行 live E2E或重启应用。

数据库为 `/Users/cisco/Library/Application Support/三人同游/vbk-desktop.sqlite`，连接使用 SQLite只读模式。表内最新产品更新时间为 `2026-10-04T04:00:05Z`，即北京时间 12:00:05；这不是所有调查查询的共同事务时间。近七日样本按该时间往前七日及产品 `updated_at` 计算，不等于近七日新建产品。

| 数据源 | 当前数量与限制 |
| --- | --- |
| products | 76个产品 |
| workflow_tasks | 122行，最新任务覆盖76个当前产品；任务多为原地更新 |
| automation_runs | 86行，最新运行覆盖75个当前产品 |
| agent_snapshots | 原始80行，关联当前产品76行，另4行不关联当前产品 |
| operation_log | 恰好10,000行，最早约北京时间2026年9月30日20:35；更早历史不完整 |
| planning_generation | 0行；不能据此断言从未规划，当前入口已使用Agent |

没有对平台进行本轮实时回读。下文所称平台壳ID、已保存和回读事实来自本地留存的运行记录，实施时必须重新独立核对。

## 当前结果与未闭合案例

| 层级 | 关联当前产品后的最新状态 |
| --- | --- |
| 产品 | 71 draft_saved，4 blocked，1 planning |
| workflow | 70 succeeded，4 needs_attention，1 failed，1 abandoned |
| automation | 71 succeeded，4 failed，1无运行 |
| Agent | 67 completed，7 paused，1 failed，1 abandoned |

70个产品同时具有产品草稿保存、workflow成功和automation成功的本地结果，其中5个交通阶段仍为failed；这些不能直接作为70次全需求完整成功。现有记录没有可靠的首次成功率与人工救场率分母，不计算恢复率或把存量成功比例当成运行可靠性。

| 案例 | 本地产品UUID | 当前记录及执行含义 |
| --- | --- | --- |
| PLAN SENSITIVE | e0066d54-b627-4572-94b2-3fcb48dacd71 | 西宁6天5晚私家团，planning，workflow和Agent failed，约36%；模型返回422 input new_sensitive，尚无自动化运行或平台ID。应先修生成请求，不创建远端壳。 |
| NAV ITINERARY | ef61501e-82c9-469f-be46-f6e4522f996f | 西宁6天5晚私家团，blocked，itinerary约45%；记录“VBK页面未打开，跳过页面进入”后失败并等待人工。需按当时实际版本复现，不能认定当前native-only代码仍依赖导航。 |
| ACK NO SHELL | d8d10f7a-8ee7-4303-a9e2-1522334cd48f | 泸州2天1晚接口验收产品，saleControl约50%；基本信息回读Ack Failure，提示没有当前资源权限，未留下本地平台ID。没有ID不等于平台一定未创建。 |
| ACK RECONCILE | 542fb095-58bf-4588-8125-3395a1fb084e | 泸州2天1晚私家团，saleControl阻塞；记录已收到平台壳79249440，随后回读权限失败。必须先核对存在性，禁止直接重建。 |
| ACK RECONCILE SECOND | 23a30edb-b68f-4576-a2e8-62f4dc3444b5 | 泸州接口验收产品，记录平台壳79249561并回读权限失败；与前例一样先对账，禁止直接重建。 |
| TRAFFIC UNRESOLVED | 2e91cc50-304c-409d-8f1c-d6273ab19a09 | 母产品草稿成功，飞机子产品保存请求超时且未最终回读；火车是合法无资源结论。母草稿与飞机未闭合必须分别报告。 |
| TRAFFIC DEGRADED | cebc4f78-15da-4e64-b919-7f40cc1659d6 | 潮汕跟团：飞机完成finalReadback，火车无可用多出发城市。可按当前规则降级，需保留火车原因。 |

另有西宁草稿 `dd52951f-76ac-4a39-87fe-f4dcd518066b` 的automation记录成功，而另一Agent/workflow轮次被废弃。废弃是用户操作的运行终态；应该独立展示草稿结果与废弃轮次，不能将它简单归为录入失败或直接改为成功。

## 简单问题和重复询问的实际记录

后续提问专项按最新产品更新时间北京时间12:07:29倒推七日，选出52个近期更新产品，审阅其留存Agent提问事件。样本中有72次ask_user调用、78个问题字段，但只有47次调用配对生成了input_request卡，共53个问题字段，涉及23个产品。25次调用被内部消解或没有形成卡，不能计为用户实际待答问题。

以下是对问题内容及后续轨迹的人工语义分类，不是系统已经具备的错误标签，也不是全量运营提问发生率：

| 分类 | 字段数 | 结论 |
| --- | --- | --- |
| 明确重复追问 | 10 | 同一冲突或字段已经问过，后续应复用答案或当前事实 |
| 本地继续或下一步 | 7 | 不涉及新的外部授权，应按readiness和依赖自动推进 |
| 可由现有规则解决的技术处理 | 6 | 日级地域上下文、元文本清洗、明确不含交通节点应由程序处理 |
| 真实业务选择或写入授权 | 19 | 保留首次必要决定及正式确认，不能为了少问而替用户改变承诺 |
| 应先补读证据或执行适用默认 | 11 | 现有材料不足以直接决定，但应先检索，不能立即反复提问 |

| 产品 | 留存问题及后续轨迹 |
| --- | --- |
| 511d2eea-e8e0-429c-9a02-65cbfd187744 | 9月30日同一天数与送团日冲突问3次，另问下一步；10月1日本地记录最终草稿成功。首问可能必要，重复问不应依靠用户救场。 |
| 1267ceb2-a580-420a-bd96-4ca58c908563 | 10月1日实际天数选择问3次；后续workflow及automation成功，但Agent仍paused。 |
| dbdca629-74df-44ab-b09c-2bae032805d1 | 9月28至29日产生6张封面或规格卡，另9次ask没有形成输入卡；10月4日本地记录完成。先复用资产和检测规格，确实需新素材才问。 |
| f5e36865-f196-44bb-883c-821d1db5a78a | 10月2日对送火车节点与禁止新增冲突问两次，约5分钟间隔；同日最终完成。首次业务决定应持久化供后续复用。 |
| 02949a7c-2763-4ab2-bf10-085aee912e4c及ba19e2d7-75ca-4c5d-b1f4-ce0847cf11fc | 10月2日在不同产品询问相近的潮州日级POI地域问题，后续均完成；值得固化上下文推断和验证规则，不能改变meetingCity锚点。 |

“已有答案”与“新的业务变更”必须区别；不能看到问题含确认就一概暂停，也不能看到酒店候选就默认第一项而忽略用户已选酒店。本轮仅诊断，没有写入用户记忆或自动修改这些产品。

## 交通阶段的五个成功冲突记录

五个产品均启用飞机及火车往返，配置未提供mandatory字段，运行前availability均曾列两种可用；最终判断必须基于最终资源与回读，而不是最初可用标记。

| 产品前缀 | 最终证据 | 当前源码规则下的判断 |
| --- | --- | --- |
| b091c4af | 两种交通均历史skipped，缺首末日目标节点，8次只读回读未收敛，未verified | 真正未闭合；不是无可售资源结论 |
| d21b8fc4 | 飞机无可用多出发城市；火车出发城市为空不能打包 | 当前规则允许的资源降级 |
| cebc4f78 | 飞机最终回读成功；火车无可用多出发城市 | 当前规则允许的部分交付 |
| 27f7cae0 | 飞机最终回读成功；火车无可用多出发城市 | 当前规则允许的部分交付 |
| 2e91cc50 | 飞机保存请求超时且无最终回读；火车无可用多出发城市 | 飞机未闭合，火车可降级 |

`src/main/automation/ctrip/traffic-line/helpers.ts:98` 定义明确无资源原因，但 `:109` 的 `trafficLineChildShouldBeSkipped` 也接受历史 `skipped=true`，不检查该标记背后的原因。`run-phase.ts:128` 又针对已确认可用却技术失败的分支抛错。恢复与完成投影必须统一这两处的业务语义，不能让历史skipped掩盖保存超时。

这属于来源与代码对应的判断，仍需R0离线夹具及真实平台条件下再核验；不是本轮已完成的平台验收。

## 源码对应的现有能力与缺口

以下路径均相对仓库根目录，行号为调查时定位，后续实施需按符号重定位。

| 证据位置 | 事实及结论边界 |
| --- | --- |
| src/main/agent/core-tools.ts:235 | ask_user先复用部分产品字段和自动默认，再将剩余问题设为pendingInput；已有防重复能力，不能说完全没有。 |
| src/main/agent/preparation-question-defaults.ts:20 | 主要按questionId/label正则决定答案，部分取第一个普通选项或前五个酒店；缺少统一字段及决策影响证据。减少提问须避免随意取第一项。 |
| src/main/agent/pending-question-reconciliation.ts:64 | 文字包含“选择、确认、修改”等时跳过持久值复用；同一事实换提问措辞可能再次进入用户等待。 |
| src/main/agent/core.ts:335 | 旧问题被当前产品全部满足后，:352仍取消交互并pause，要求“请继续当前方案”。这是无需回答却仍需人工继续的直接代码来源。 |
| src/main/agent/pending-question-reconciliation.ts:56 与 core-tools.ts:264 | 正确沿用已上传人工封面却设置pause；需先机器检测规格，合格后自动继续，必要上传动作才暂停。 |
| src/main/agent/preparation-action-guard.ts:6 | ask_user列为不受准备动作门约束，提示词限制没有形成完整程序提问门。 |
| src/main/automation/automation.main/automation.main.make-context.ts:11 | Agent-controlled advisor固定返回wait_for_user。普通handler失败时，通用恢复很快转需处理，专用恢复器能力未形成统一自动闭环。 |
| src/main/agent/core-tools.ts:17 | 通用失败提示引导“再试一次，仍失败换策略或ask_user”，没有要求先判是否用户能解决。 |
| src/main/agent/integration-setup.ts:75及:201 | 已有显式记忆注入模型，提问消解接口尚未统一接入决策上下文。复用已有能力即可，无需新建记忆体系。 |
| src/main/agent/core-tools.ts:141 | 直接等待业务工具返回，没有统一生命周期期限；个别内部接口超时不能覆盖整工具挂起。 |
| src/main/agent/core-loop.ts:141 | 无工具回复已过完成检查；:32有80轮保护。不断调用工具的语义停滞仍需另行检测。 |
| src/main/agent/core-snapshot.ts:263 | 失败去重依赖工具、参数与错误；:292的成功本地写可重置blocker。不能以此证明必要缺项前进。 |
| src/main/agent/core-snapshot.ts:205 | 流式内容更新可约48ms保存一次；:53复制完整快照。是代码性能风险，尚无实测写入耗时。 |
| src/main/agent/integration-setup.ts:279 与 src/main/main.ts:181 | 保存Agent快照发事件，事件更新workflow和产品诊断。流式展示与业务产品更新需要分离。 |
| src/main/infrastructure/vbk-browser.ts:682 与 vbk-request-page.ts:27 | 当前普通桌面录入使用native-only客户端，并检查捕获账号是否仍活跃。历史页面内fetch协议不是本轮当前默认。 |
| src/main/infrastructure/vbk-session-request.ts:340 | 非native兼容路径上下文丢失或网络错误后重发相同请求，缺读写意图。重复投递为代码风险，本轮未证明实际重复产品。 |
| src/main/agent/core-tools.ts:183 | Retry-After路径未利用requiresApproval区分外部写；只有已标uncertain或授权拒绝才不自动重试。 |
| src/main/automation/recovery/recovery-run.ts:56 | 关键persist异常被吞，runner可继续；应在写入边界改为停止。 |
| src/main/agent/integration-reconcile.ts:24 | 已有saleControl/basic/hotelResource/trafficLine/preflight只读核对；其余阶段缺统一比较契约。basic现核产品与供应商编号，未比全部操作期望字段。 |
| src/main/automation/ctrip/hotel-resource-page.ts:60 | 已逐段保存、回读和ID重映射，内容变化停止。缺新进程部分写恢复的完整验收，不能说没有部分恢复能力。 |
| src/main/automation/ctrip/pricing-group-batch.ts:18 | 已按年季月日缩小批次，并回读剩余日期；进展治理应复用，不再次逐日全重写。 |
| src/main/agent/integration-guard.ts:37 与 core-handoff.ts:39 | 确定性运行允许指纹漂移及刷新；存在过宽复用风险，尚未证明实际错授权。 |
| src/shared/contracts-types.ts:216 与 automation.main.run.ts:335 | phase仅有状态，恢复直接跳过completed；没有逐阶段输入语义指纹绑定。 |
| src/main/infrastructure/database/parts/workflow-tasks.ts:129 | 存在任何Agent snapshot就拒绝旁路草稿任务收敛；需按当前run和证据区分终态，不能直接覆盖abandoned。 |
| src/main/planning/stage-deterministic-completion.ts:25 | 已有图文和商业模块的确定性补齐，应作为自动下一步复用。 |
| src/main/planning/vbk-recommendation-length.ts:16 | 当前计数是Latin-1为1、其他UTF-16码元为2；不能沿用旧Unicode字数约定。 |
| docs/handoff/2026-10-04-private-tour-feedback-fixes.md | 当前已明确逐景点配图尽力执行且非阻断；不能重新把它列为必要准备项。真实平台验收仍另列。 |
| test/e2e/live-product-entry.e2e.test.ts:40 | 从预置JSON直接调用阶段，没走桌面新建、Agent生成和正式确认；没显式酒店/用车或重启。 |
| scripts/run-tests.mjs:43 | Node默认timeout60秒，live用例自身300秒；静态不足以认定其已被60秒截断，执行时核验。 |

## 快照体积与性能采样缺口

当前76个产品关联快照：JSON字节中位数174,768，P90为397,109，最大4,231,762，总量约20.27MB；events中位数136，P90为278，最大2,681。最大快照对应潮州5天4晚跟团游，足以作为隔离性能夹具规模。

操作日志未记录Agent流式快照的SQLite写入耗时，无法据此给出p95或主线程延迟，也不能把体积直接换算成运行卡顿原因。R1先量化流式保存、业务更新、镜像和主线程延迟，再决定是否拆存储表。

## 历史证据的使用方式

10月3日已出现并修复过无工具提前完成、非法词Warning、产品类型不支持车辆阶段、酒店API被导航阻断及部分酒店资源保存等问题。历史修复帮助选择复现样本，不证明当前应用版本已生效或所有新产品同输入都能完成。

`docs/agent-loop.md` 仍描述旧execute_vbk_phase及仅壳核对；`docs/vbk-api/contract.md` 仍称Phase0 blocked并缺基本信息/套餐/酒店保存，与当前源码有冲突。R0应将旧文档保留为历史证据，校正当前入口与实测状态。现有用户记忆执行文档也仅作能力线索；复用偏好前必须核实当前实现、账号范围与明确授权。

## 本轮已做与未做

已做：源码定位、只读数据库交叉核对、最新与历史状态区分、交通降级复核、快照体积采样、当前类型检查、工作包和验收门设计。

未做：业务代码修复、实时VBK协议对照、旧产品恢复、真实平台写入、完整用户路径验收、性能实测、Git提交推送或发布。不得把本轮规划标为稳定性修复完成。
