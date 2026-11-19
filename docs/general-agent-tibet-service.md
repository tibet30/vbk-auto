# 三人同游服务端接入（只读）

本文是 [当前实现细节](/Users/cisco/Documents/vbk-auto/docs/general-agent-current-implementation.md) 第 8 步的展开，
记录三人同游（Tibet）服务端 service token 接入的事实、边界与验证方式。
续做入口仍是 [续做交接](/Users/cisco/Documents/vbk-auto/docs/general-agent-continuation-handoff.md)。

## 1. 令牌与身份

业务侧签发的是 `stk_` 前缀的**服务级令牌**（不是人登录态），两种传法都行：
`Authorization: Bearer stk_…` 或 `X-Service-Token: stk_…`。服务端契约（2026-11-17 实测，后端源码在本机 `~/pro/tibet`）：

- 统一信封 `{ code, message, data }`，HTTP 状态与 `code` 同值；401 = 缺失/无效/已过期/已吊销，403 = 有效但缺身份或缺动作权限；
- 令牌**默认继承创建者管理员身份**，并可按类型叠加业务身份（客户 / 扩展用户 / 定制师，每类最多一个）；
  同一个人的多个账号可以用一个令牌覆盖：`bound_identities` 返回全部身份，中间件按类型分别注入；
- 后台 `POST/PUT/PATCH/DELETE /api/admin/*` **不接受**服务令牌（长期凭证不代写后台）；`/api/service-tokens*` 永不接受。

生产现状（2026-11-17）：令牌 `ansike` 绑定客户 `18835112829`、扩展用户 `18835112829`、创建者管理员 `admin`；
`GET /api/open/me` 返回三条身份，`/api/admin/services`、`/api/extension/vbk-bindings`、`/api/user/orders` 均 200。

## 2. 能力清单（全部只读，7 个动作）

| 动作 | 读什么 | 需要的身份 |
| --- | --- | --- |
| `tibet.status` | 令牌状态、权限、有效期、全部可用身份 | 无（未配置时也可读本地状态） |
| `tibet.services` | 公共在售服务目录（筛选 + 分页） | 无 |
| `tibet.adminServices` | 后台服务目录（含已下架、排序、上下架状态） | 管理员 |
| `tibet.service` | 单个服务详情（亮点/包含/集合/取消规则） | 无 |
| `tibet.vbkBindings` | 本账号的 VBK 绑定（管家联系人、400 电话、供应商、当前使用） | 扩展用户 |
| `tibet.orders` | 客户订单列表（可按状态筛选） | 客户 |
| `tibet.order` | 单笔订单详情 | 客户 |
| `tibet.productReference` | 按本地产品标题与城市比对平台在售服务与起价（定价参考） | 无（未配置令牌时如实说明） |

## 2.1 平台在售参考（定价参考，不进门禁）

`src/main/infrastructure/tibet-platform-reference.ts`：

- 城市：平台字典（`/api/dictionaries`，城市展示名在 `label` 字段）中文短名 → `city_code`，进程内缓存 10 分钟；
  产品侧只去掉尾部「市」，**不能**把「州/区/县」当尾缀削掉（否则「广州」会变成「广」）；
- 相似度：中日韩二元组重叠率（数字按分隔符处理），同城阈值 0.15、跨城阈值 0.34；达不到就是「没有找到」；
- 差价：平台起价与产品成人价（`commercial.pricing.adult`）相减，缺任一侧则不比较；
- 出口：`tibet.productReference` 动作 + 产品审查面板「平台在售参考」卡片（IPC `tibet:platformReference`，只传产品 id）。
- 边界：结果**不写入产品**、不参与程序检查与运营确认，卡片文案里明写「仅供参考」。

## 3. 代码分层

- `src/main/infrastructure/tibet-service-transport.ts`：基地址 / 令牌解析 / 信封 / 401·403·其它错误分类；
- `src/main/infrastructure/tibet-service-catalog.ts`：公共目录与后台目录；
- `src/main/infrastructure/tibet-service-business.ts`：VBK 绑定与客户订单；
- `src/main/infrastructure/tibet-service-client.ts`：门面，组合上述三层的只读能力 + `selfCheck()`；
- `src/main/infrastructure/tibet-service-token-store.ts`：本机 0600 文件存储（`userData/tibet-service-token.json`），
  环境变量 `TIBET_SERVICE_TOKEN` 优先且不污染文件；非法令牌拒绝落盘；
- `src/main/infrastructure/tibet-service-token-status.ts`：本地状态 + 服务端自检合成快照（「已保存」≠「已验证」）；
- `src/main/agent-runtime/skills/tibet-readonly/{port,describe,actions,index}.ts`：端口契约、人话渲染、动作定义与装配；
- `src/main/agent-workspace/tibet-adapter.ts`：把客户端接成 `TibetReadPort`；令牌解析器每次请求前读一次，设置页改完立即生效。

## 4. 不变量

- 只注册 `read` 动作；写入必须另有 `preview` + `reconcile`，否则装配期被 `assertBackendWritesAreVerifiable()` 拒绝；
- 读不到就抛错（执行器记 failed 收据），绝不把 403「没身份」写成「没有数据」；
- 缺字段如实说明（例如订单没有服务标题时显示服务 id + 「平台未返回标题」），不推断、不补全；
- 明文令牌永不回传 renderer，设置页只看掩码。

## 5. 验证

- 单元/契约测试：`test/infrastructure/tibet-service-{client,transport,catalog,business,token-store,token-status}.test.ts`、
  `test/agent/tibet-readonly-skill.test.ts`；
- 生产实跑（不带环境变量，仅靠本机文件）：`tibet.status` 报出三条身份；`tibet.adminServices` 读到 20 条后台目录；
  `tibet.vbkBindings` 读到 2 个绑定（当前使用 `vbk_671205`）；`tibet.orders` 读到 4 条真实订单；
- 设置页真实窗口验证：保存令牌后卡片回显「已保存 / 本机文件 / 服务端已确认」，磁盘文件为 `-rw-------`；
- 产品面板真实窗口验证（2026-11-17，临时用户数据目录里把一条产品标题改成「广州长隆亲子一日陪同动线规划」、城市广州、成人价 600）：
  卡片显示「1 条相近 · 广州长隆亲子一日陪同与动线规划 · ¥680 · 广州 · 约8小时 · 比产品高 ¥80 · 同城，标题相似 92%」；
- 首页「查我的订单」「查 VBK 绑定」两个入口在真实窗口里为 `data-state="ready"`。
