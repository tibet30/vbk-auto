# 通用智能体：续做交接（面向下一个执行模型）

更新时间：2026-11-17  
仓库：`/Users/cisco/Documents/vbk-auto`（Electron + React + SQLite 桌面工作台）  
本文是**续做入口**。历史背景见文末「相关文档」，但按本文就能接着干。

## 0. 一句话现状

通用智能体（工具运行时 + 本地文件 / 演示文稿 / 网页 / 产品只读 / 本机账号 / VBK 只读 / VBK 写入 / MCP）已经全部实现、验证并提交（5 个 commit，未 push）。剩下两件事**都需要用户输入**：① 一次受控的真实 VBK 写入验收；② 三人同游后台 adapter（等业务侧的 Token 方案）。

## 1. 开工前必读的硬约束

1. 根目录 `AGENTS.md`：文件 ≤350 行、`行程规划 → 程序检查 → 运营确认 → 行程录入` 状态机、5 项正向 + 20 项负面强制回归、高风险操作红线（commit/push/发布需用户显式授权）。
2. **决策 A（2026-11-17，用户拍板）**：通用智能体的 `once`/`thread` 授权**不得**顶替产品的「运营确认」。产品域永久只读，代码守卫是 `assertProductActionsReadOnly()`；产品**写入**必须先过 `readiness.ready` + `itinerary_review_unlock.status === "verified"` 且有 `approvalId`。
3. 工作区有 **17 项并行脏改动不属于本阶段**（AI 设置 / minimax / 旧对话页等），**不要提交、不要重构、不要顺手清**。清单见 `git status --short` 里除 agent 相关路径外的条目。
4. 文档也受 350 行硬上限约束（有测试 `test/infrastructure/product-architecture-boundaries.test.ts` 盯着）。增长时按职责拆分，不要硬塞。

## 2. 已完成内容（有实证）

### 2.1 提交记录（分支 main，ahead 5，未 push）

```
392118f7 docs(agent): 交接文档、实现细节、SDK 选型与 VBK 写入计划
06f25ccb test(agent): 运行时、Skill、界面与文档一致性测试，附 MCP 夹具
48e65695 feat(agent): 智能体界面（面板、审批、产物预览、历史、Skill 启停、首页能力、MCP 配置卡片）
27e01a7c feat(agent): 工具运行时、事实模型与内置 Skill
2b1a095e chore(agent): 增加 pptxgenjs 与 MCP SDK 依赖
```

### 2.2 模块地图

```
src/main/agent-runtime/           运行时（37 个文件）
  skill-registry / permission-policy / path-scope
  action-executor                  写锁、幂等、收据、uncertain 收敛
  run-loop / run-service           多步模型—工具循环、暂停/恢复/取消/继续
  artifacts                        产物解析、应用内预览构建
  skill-scope                      任务级 Skill 裁剪
  mcp/{client,skill,source,config} MCP 外部工具
  skills/                          local-file, deck, web, product-readonly,
                                   account-readonly, vbk-readonly, vbk-write,
                                   tibet-readonly, backend-write-guard
src/main/agent-workspace/
  service.ts                       会话/运行/审批/产物/能力清单编排
  ports.ts                         只读端口投影（产品/账号/VBK）
  external-tools.ts                MCP 运行期容器
  model-context.ts                 系统提示与 provider 装配
  vbk-adapter.ts                   VBK 只读端口真实装配
  vbk-write-adapter.ts             VBK 写入端口 + 门禁
src/main/infrastructure/database/
  parts/agent-runtime*.ts          运行/工具调用/授权/收据/迁移
  parts/agent-workspace.ts         线程与消息（按 rowid 排序）
  parts/migration-registry*.ts     迁移汇总与历史声明
src/renderer/app/views/agent/      对话页、右侧面板、产物预览、Skill 条
src/renderer/app/views/settings/agent-tools-block.tsx   MCP 配置卡片
```

迁移：`0019_agent_runtime`、`0020_agent_receipt_artifact`、`0021_agent_thread_enabled_skills`。

### 2.3 能力清单（都在真实窗口验证过）

| 能力 | 动作 | 授权要求 |
| --- | --- | --- |
| 本地文件 | `file.list/read/create/modify/overwrite/move/delete` | 读静默；写/删需授权；删除移入 `.agent-trash` |
| 演示文稿 | `deck.generate` | 需授权；同名旧版归档后再写 |
| 网页 | `web.build` | 需授权；整目录归档后重建 |
| 产品（只读） | `product.list/status` | 只读，永久 |
| 本机账号（只读） | `account.list/status` | 只读 |
| VBK（只读） | `vbk.status/contacts/poi` | 只读，真实后台验过 |
| VBK（写入） | `vbk.product.basicInfo` | 门禁 + 审批；收据带 before/result |
| MCP 外部工具 | 动态 | 无 `readOnlyHint` 一律按写入处理 |

治理：审批卡、收据（含 `before`）、幂等键、账号级写锁与队列可见性、「继续运行」、不确定写入核查（`uncertain → succeeded/failed` 单向收敛）、任务级 Skill 启停、后台写准入守卫（缺 `preview`/`reconcile` 拒绝装配）。

## 3. 如何验证（照着跑）

```bash
export PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH"   # 本机 node 在 nvm 里，PATH 默认没有

npm run check          # tsc 双工程
npm run build          # vite + tsc
npm run test:changed   # 受影响测试 + 强制 5 项正向/20 项负向（收据会打印）
npm run test:all       # 全量（含浏览器层、集成层），约 10 分钟
```

基线：全量 **4450 项通过、0 失败、0 跳过**；提交后 `test:changed` 跑 3153 项 + 强制 25 项全绿。

### 3.1 真实窗口调试（最有价值的验证方式）

```bash
npm run dev:renderer &                       # vite，注意端口可能退到 5175
env -u ELECTRON_RUN_AS_NODE npx electron .   # 必须 unset，否则 Electron 退化成 node
grep -o "DevTools listening on ws://127.0.0.1:[0-9]*" /tmp/<log>   # 端口随机（9300-9899）
```

然后用 Playwright `chromium.connectOverCDP` 连上去，页面 URL 含 `127.0.0.1:5173` 的那个才是 app 渲染进程（另一个是 VBK BrowserView）。dev 用户数据在 `~/Library/Application Support/三人同游-dev`，不碰生产数据。

### 3.2 打包验证

`npm run package:mac:dir` → **输出 16G**（universal 中间产物），验证完立刻 `rm -rf release`。用 `VBK_USER_DATA_DIR=/tmp/xxx` 隔离用户数据启动 `.app`。

## 4. 未完成事项与下一步

### 4.1 一次受控真实 VBK 写入（等用户拍板）

已实现 `vbk.product.basicInfo`：把本地产品**整块基本信息**写入 VBK（标题/副标题/城市/天数/400 电话/管家联系人/提前预订/景区规则）。

- 门禁：本地产品存在 → 已回填 VBK 产品 id → `readiness.ready` → `itinerary_review_unlock.status="verified"` 且有 `approvalId`；**批准后状态变化会在执行阶段重新校验并拒绝**。
- 已知风险：不是单字段补丁，是整块重放；标题会按平台命名规则重新生成；账号必须已配置 400 电话与管家联系人卡，否则动作直接拒绝。

已验证满足前三条的候选（程序检查由应用内实时校验）：

| 库 | 产品 | 本地 id | VBK id |
| --- | --- | --- | --- |
| 开发 | 阿里9天8晚跟团游 | `9a5db9e6` | 81542664 |
| 开发 | 西宁4天3晚私家团 | `fa027916` | 81524634 |
| 生产 | 广安2天1晚私家团 | `5a9c1e79` | 79779063 |

**流程要求**：先跑 preview 给用户看「VBK 现值 vs 将写入值」→ 用户明确说"执行" → 才真正写入 → 回读核对 → 给收据。**没有得到"执行"二字的明确授权，不要写真实后台。**

### 4.2 三人同游后台 adapter（业务侧已给服务令牌，公共目录已接）

业务侧提供的是一次性 **service token**（`stk_` 前缀），两种传法都行：
`Authorization: Bearer stk_…` 或 `X-Service-Token: stk_…`。

2026-11-17 实测（直连生产基地址 `https://www.atdtour.com`，后端源码在本机 `~/pro/tibet`）：

| 项 | 已验证事实 |
| --- | --- |
| 令牌 | 名称 `ansike`，权限「只读 / 创建 / 编辑」，状态生效中，到期 2027-05-16（剩余 180 天） |
| 绑定身份 | **未绑定**（`bound_identity: null`）。个人数据接口一律 403，回包直说缺哪种身份 |
| 服务端契约 | 统一信封 `{ code, message, data }`，HTTP 状态与 `code` 同值；401 无效/过期/吊销，403 缺身份或缺权限 |
| 现在可读 | `/api/open/ping`、`/api/open/me`、`/api/services`（筛选项 country/city/type/audience/duration_bucket/price_min/price_max/search/hot/sort/page/page_size）、`/api/services/<18 位 public_id>`、`/api/dictionaries`、`/api/region/list` |
| 现在不可读 | `/api/user/*`（需绑客户）、`/api/extension/*` 与 `/api/product/dump/config`（需绑扩展用户）、`/api/designer/*`（需绑定制师）、`/api/admin/*`（服务令牌被刻意豁免，仍要 AdminUser 登录令牌） |

本轮已落地（只读，不碰任何服务端写入）：

- `src/main/infrastructure/tibet-service-client.ts`：服务端客户端。凭证只从环境变量 `TIBET_SERVICE_TOKEN` 读，
  **不落库、不落文件**；401/403/其它分别映射为认证错误 / 权限错误 / 通用错误，不把「没权限」说成「没数据」。
- `src/main/agent-runtime/skills/tibet-readonly/index.ts`：Skill `tibet`，三个只读动作
  `tibet.status`（令牌状态/权限/有效期/绑定）、`tibet.services`（目录筛选与分页）、`tibet.service`（按 public_id 读详情）。
- `src/main/agent-workspace/tibet-adapter.ts`：端口装配。未配置令牌时端口仍然存在——公共目录照读，自检如实报「未配置」。
- 装配点：`createAgentRuntime(..., { tibet })`；`AgentWorkspaceService.buildRuntime()` 已接入。

实跑验证（真实令牌、真实生产接口）：`tibet.status` 报出「ansike / 生效中 / 剩余 180 天 / 未绑定」；
`tibet.services` 搜「蓝山」命中 1 条（public_id 172708729898149707，¥760）；`tibet.service` 完整列出亮点、包含/不包含、集合说明、须知与取消规则。

### 4.2.1 身份规则：令牌默认继承创建者（2026-11-17 用户在 half 中拍板）

用户口径：「谁创建的，谁就拥有创建者的身份」——不再让人手工挑绑定身份。后端 `~/pro/tibet` 已按此改造并**已部署生产**（commit `6b4cd90`，2026-11-17，119 项本地测试 + 生产回读验证通过）：

- `ServiceToken` 新增 `creator_admin`（创建者管理员），创建时自动记录；未显式绑定业务身份时
  `bound_identity` 回落到创建者，令牌即以该管理员身份工作；
- 显式绑定客户 / 扩展用户 / 定制师仍然优先（需要「只以某业务身份工作」时用）；
- `/api/admin/*` 的**只读**接口因此可被继承身份的令牌调用；后台**写**操作仍只认人登录令牌，
  `/api/service-tokens*` 永远只认登录令牌——长期凭证不会变成后台写后门；
- 继承的管理员被禁用/删除时，令牌立即降级为未继承（403 明确说明，不静默变成公共读）。

**部署时解决的阻塞点（已实测）**：生产 `tblAdminUser` 原本 **0 行**——创建令牌的是 Django `auth.User`（`created_by = "admin"`），
两套账号体系各自独立。部署时给 `admin` 建了一条同名的服务目录管理员（identity-only，密码为空即无法登录），
再用 `backfill_service_token_identity --apply` 把 `ansike` 令牌补记到该身份。之后：

- `GET /api/open/me` 返回 `bound_identity: {type: admin, label: 管理员（创建者继承）, key: admin}`；
- 令牌可读 `GET /api/admin/services`、`GET /api/admin/dictionaries/<type>`（真实服务目录数据）；
- `POST /api/admin/services` 仍是 403「服务令牌只读」；`GET /api/service-tokens/` 仍 401（令牌管理只认登录令牌）；
- 桌面端 `tibet.status` 已实测显示「绑定身份：管理员（创建者继承）（admin）」，`tibet.services` 读到真实目录 20 条。

运维提醒：这个管理员是身份锚点，没有密码、无法登录；要换成真人管理员时，在后台「服务令牌」页把「绑定管理员用户名」
改成目标账号即可。撤销方式：吊销令牌，或删掉/禁用该管理员（令牌立即降级为未继承，接口回 403 明确说明）。

### 4.2.2 三个数据能力已全部接入（2026-11-17，用户要求「都继续做」）

后端先补了「身份按类型叠加」（commit `319de13`）：业务身份与创建者继承可并存，每类最多一个，
中间件按类型分别注入 `request.customer` / `request.extension_user` / `request.admin`。
生产令牌 `ansike` 现绑定客户 `18835112829` + 扩展用户 `18835112829` + 创建者管理员 `admin`。

桌面端新增四个只读动作，加上原有三个共 7 个：`tibet.status` / `tibet.services` / `tibet.adminServices`（后台目录，
含下架项与管理字段）/ `tibet.service` / `tibet.vbkBindings`（VBK 账号绑定）/ `tibet.orders`（客户订单，可按状态筛选）/
`tibet.order`（单笔详情）。

生产实跑（不带环境变量，仅靠本机令牌文件）：后台目录 20 条、VBK 绑定 2 个（当前使用 `vbk_671205`）、
客户订单 4 条（2 条待支付、1 条已取消等）。订单没有服务标题时如实显示服务 id + 「平台未返回标题」，不编造。

### 4.2.3 暴露到界面与产品侧（2026-11-17，用户要求「按建议继续」）

- 首页快捷入口：「查我的订单」「查 VBK 绑定」（`AgentHome.tsx` 的 STARTERS，绑定 `tibet` Skill；没有该 Skill 时显示未安装）；
- 产品审查面板新增 `PlatformReferenceCard`（`review-summary/platform-reference.tsx`）：按产品标题 + 城市比对平台在售服务，
  显示起价、与成人价的差价、命中的原因（同城/标题相似度）与 public_id，并固定注明「仅供参考：不参与程序检查与运营确认」；
- 新增 Skill 动作 `tibet.productReference`，智能体也能在对话里直接问「这个产品平台上有对应服务吗」；
- 匹配逻辑在 `src/main/infrastructure/tibet-platform-reference.ts`：平台城市字典中文名 → `city_code`（缓存 10 分钟）、
  中日韩二元组相似度（同城 0.15 / 跨城 0.34 阈值）、差价对比；达不到阈值就是「没有找到」，不硬凑。

真实窗口验证：把一条产品标题改成「广州长隆亲子一日陪同动线规划」+ 广州 + 成人价 600，面板卡片显示
「1 条相近 · 广州长隆亲子一日陪同与动线规划 · ¥680 · 比产品高 ¥80 · 同城，标题相似 92%」；首页两个新入口为 ready。

下一步要先定的事：

1. **参考价是否要写进产品**（例如作为定价页面的「平台参考」字段）：现在刻意只读、不落产品事实，要落库需要定字段与口径。
2. **规划期自动核对**：现在需要人/智能体主动查询；若要在生成方案时自动带出参考，需要定「自动查询失败是否阻塞规划」——按现有基调应当不阻塞。
3. 后台**写**仍未开给令牌（改服务/上下架），需要时另议（必须先有 preview + reconcile）。

写入动作（该令牌其实带 create/edit 权限）暂不接：每个写动作必须先有 `preview` 与 `reconcile`，否则装配期就被
`assertBackendWritesAreVerifiable()` 拒绝。


### 4.3 其余写动作（等 4.1 验收通过再扩）

顺序建议：换封面（可逆）→ 资源绑定（影响可售）→ 发布/上下架（不可逆、触平台审核，最后做）。每加一个动作必须同时具备 `preview` 与 `reconcile`，否则装配期即被拒。

## 5. 这个阶段踩过的坑（别重复）

1. **SQLite 排序**：`ORDER BY created_at, id` 在同毫秒写入时会退化成随机 UUID 排序，导致对话顺序反转。追加写账本一律按 `rowid`。
2. **收据不能撒谎**：只读动作失败时若 catch 后返回文本，会记成 `succeeded` 但正文说失败。正确做法是抛错，让执行器记 `failed`。
3. **providerId 缓存缺失**：VBK 会话已登录但本机没缓存时，应现场探测（`detectProviderIdFromBrowser`）并回写缓存，而不是直接失败。
4. **面板可见性**：只认"审批/运行/工具调用"会让"只剩产物"的任务整块面板消失；产物与外部工具失败也必须算可见理由。
5. **IPC 覆盖测试的注册器清单**漏了文件会让整批通道不被检查；新增 registrar 必须同步加进清单。
6. **文档也会超 350 行**：增补小节时注意锚点唯一，避免把内容插到别的章节（本阶段就出现过重复小节）。
7. `ELECTRON_RUN_AS_NODE=1` 若在环境里，`npx electron .` 会当 node 跑并报 `does not provide an export named 'WebContentsView'`；用 `env -u` 去掉。

## 6. 相关文档

- [当前实现细节](/Users/cisco/Documents/vbk-auto/docs/general-agent-current-implementation.md)：各能力的不变量与边界（本阶段实证记录）
- [VBK 写入实施计划](/Users/cisco/Documents/vbk-auto/docs/general-agent-vbk-write-plan.md)：写动作清单、验收门、决策 A 说明
- [SDK 选型评估](/Users/cisco/Documents/vbk-auto/docs/general-agent-sdk-evaluation.md)：为什么用 AI SDK / MCP SDK / PptxGenJS，不引入 LangGraph、Mastra
- [上一版交接](/Users/cisco/Documents/vbk-auto/docs/general-agent-implementation-handoff.md)：需求来源、产品决策、原始实施步骤与验收要求
