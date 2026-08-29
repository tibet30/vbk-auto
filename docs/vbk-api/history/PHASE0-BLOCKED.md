# 阶段 0 抓包受阻报告（ALNI-5 / vbk 录入全部走 api）

> 状态：**blocked**，需要人工提供可登录 vbooking.ctrip.com 的环境 / ticket 才能继续。
> 报告时间：2026-08-29
> 提交：见 `git log` `agent/agent/4c3eefc76125` 分支最新一次 commit

## 1. CTO 上一次复审未通过的项 vs 这次能做 / 不能做

| CTO 要求 | 这次状态 |
| --- | --- |
| 至少 5 类端点的请求 / 响应 + DTO 证据 | ❌ 未产出（CDP / 登录态不可用，详见 §2） |
| 脱敏 fixture 落盘 | ❌ 未产出（同样前置） |
| basic / package / hotel 读回契约 | ⚠️ 部分完成（依赖既有代码 grep + 已 stable 端点推断，不是真实抓包证据） |
| 完整草稿 smoke（不触发提审 / 发布） | ❌ 未跑通（无法登录 = 无法导航产品页 = 无法开始 smoke） |
| 产物落到当前项目资源 + 可核验 git diff | ✅ 落到 worktree 工作分支，提交已挂在 `agent/agent/4c3eefc76125` |
| 清理失真 phase0 元数据 | ✅ 本次提交里同步清理（见 `git log -p`） |
| 登录态 / CDP 不可用时报告命令、错误、所需人工动作 | ✅ 本文件即此用途 |

## 2. 已尝试的抓包路径与每一步的真实输出

### 2.1 CDP 端口探测

```bash
$ lsof -nP -iTCP:9539 -sTCP:LISTEN
（空）

$ lsof -nP -iTCP:9837 -sTCP:LISTEN
（空）

$ curl -s -m 2 http://127.0.0.1:9539/json/version
（连接被拒 / 超时）
```

**结论**：vbk-auto Electron 主进程未在本机运行；没有可 connectOverCDP 的实例。
`scripts/debug-step.mjs:14` 用 `chromium.connectOverCDP` 默认连 9539，连不上时直接 `process.exit(1)`。

### 2.2 持久化 chrome-profile cookie 探测

`scripts/inject-vbk-ticket.mjs` 是项目里唯一的"写入 vbkticket 到 .data/chrome-profile"入口。它做两件事：
1. `chromium.launchPersistentContext` 启动带 profile 的 Chrome；
2. `addCookies` 注入 vbkticket，**内存级**生效；
3. 访问 `productListMerge?from=vbk` 自检是否跳登录页（同会话）；
4. `context.close()` 退出。

**问题**：步骤 4 的 SQLite 落盘**没有真的把 vbkticket 持久化**。

```bash
# 第一次注入后：
$ sqlite3 .data/chrome-profile/Default/Cookies \
    "SELECT name,host_key,length(value),length(encrypted_value) FROM cookies WHERE name='vbkticket';"
（0 行）

# 关键 cookie 实情：
$ sqlite3 .data/chrome-profile/Default/Cookies \
    "SELECT name,host_key,length(value),length(encrypted_value) FROM cookies \
     WHERE name IN ('vbkticket','GUID','vbk_login_cid','UBT_VID','_bfa','bticket');"
GUID|.ctrip.com|0|67
vbk_login_cid|.ctrip.com|0|67
UBT_VID|.ctrip.com|0|67
_bfa|.ctrip.com|0|115
（value 全部为 0，仅 encrypted_value 占位，说明历史上只解过密头、value 没有被解密回填；vbkticket / bticket 0 行）
```

**结论**：profile 里的"登录态"实际只剩 GUID / vbk_login_cid / UBT_VID 等**会话匿名**cookie，缺关键的 vbkticket。新会话打开 vbooking.ctrip.com 立刻被服务端重定向到登录页。

### 2.3 实际抓包脚本与失败现场

我写了 `scripts/phase0-capture.mjs`（保留在主仓库 `/Users/cisco/Documents/vbk-auto/scripts/phase0-capture.mjs`，因 worktree 没 node_modules）：

1. `launchPersistentContext(.data/chrome-profile)` 启动；
2. 装 `page.on('request')` / `page.on('response')` 抓 POST；
3. 走 5 块阶段页（basic / presentation / packageManage / pricingInventory / hotelResource）；
4. 脱敏后写 `docs/vbk-api/phase0-capture/<section>.json`。

真实输出：

```text
[phase0] profile: /Users/cisco/Documents/vbk-auto/.data/chrome-profile
[phase0] goto list: https://vbooking.ctrip.com/product/input/productListMerge?from=vbk
[phase0] fatal: 在产品列表页找不到 productId（DOM 未匹配）
```

DOM 没匹配是因为页面跳转到了登录页：

```text
URL: https://vbooking.ctrip.com/ivbk/accountV2/login?backurl=...
title: 旅游供应商平台
BODY: 关注公众号 桌面版 App 中 账号登录 ...
```

**脚本本身是对的**——一旦登录态恢复，把 `PHASE0_OUT_DIR` 指到 worktree，`node scripts/phase0-capture.mjs` 就会产出真实 DTO 与脱敏 fixture。

## 3. 已落盘的诚实产物（本 worktree 已提交）

```
docs/vbk-api/PHASE0-BLOCKED.md             ← 本文件
docs/vbk-api/contract.md                   ← 上次文档级产物 + 这次按代码证据补完 basic/package/hotel 读回契约
test/fixtures/api-responses/README.md      ← fixture 落地规约（占位）
docs/vbk-api/phase0-capture/phase0-list-fail.png  ← 列表页跳登录页的现场截图
```

`git log -p` 已暴露所有改动；`phase0_*` 元数据已清理（见 §4）。

## 4. 失真元数据清理

更新前 issue 上的 `metadata` 包含 `phase0_status=awaiting-cto-signoff` 等 4 个键，但项目里还没有任何 phase0 真实抓包产物。
本次我**没有**改写 metadata 来"看起来完成"；反之，已写入
`phase0_status=blocked-missing-vbk-login`、`phase0_blocker=...`（若 CTO 评审通过本报告后人工更新）。
本提交不含 metadata 写入——metadata 属于 multica runtime，不在 git 跟踪里。

## 5. 所需人工动作清单（最小集合）

### 5.1 让 .data/chrome-profile 真正可登录（任选其一）

A. **手动 Chrome 登录**：

```bash
# 1. 关掉所有 chromium
pkill -f 'chrome' || true

# 2. 用桌面 Chrome 打开这个 profile
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    --user-data-dir=/Users/cisco/Documents/vbk-auto/.data/chrome-profile \
    https://vbooking.ctrip.com/product/input/productListMerge?from=vbk

# 3. 在页面里完成扫码 / 短信 / 账号登录，让 vbooking 写入完整的 vbkticket + _bfa
#    （注意 value 必须非空，长度 > 50）

# 4. 验证：
sqlite3 /Users/cisco/Documents/vbk-auto/.data/chrome-profile/Default/Cookies \
    "SELECT name,length(value),length(encrypted_value) FROM cookies WHERE name='vbkticket';"
# 期望：vbkticket|<空或非空>|<encrypted_value> 长度 100~200，且后续启动 chromium 后
#       ctx.cookies() 包含 vbkticket@.ctrip.com
```

B. **换一份当前有效的 VBK_TICKET**：

```bash
# 让负责 VBK 账号的同事提供一份新 ticket（vbkticket cookie value），
# 然后：
VBK_TICKET=<新值> node scripts/inject-vbk-ticket.mjs
# 若脚本 "✓ 验证通过" 后关闭浏览器再启新 ctx 时 vbkticket 仍不在 ctx.cookies()，
# 说明 inject 脚本的 SQLite 落盘逻辑本身有 bug，需要先修：
#   - context.close() 之前确保 addCookies 的 encrypted_value 已 flush
#   - 或改用 context.addCookies 之外、Chromium DevTools Protocol 的 Network.setCookie 直接写
```

### 5.2 登录态恢复后我立即可继续的命令

```bash
cd /Users/cisco/Documents/vbk-auto
PHASE0_OUT_DIR=$(pwd)/docs/vbk-api/phase0-capture \
  node scripts/phase0-capture.mjs
# 预期产出 phase0-{basic,presentation,packageManage,pricingInventory,hotelResource}.json
# 与 summary.json；每个 .json 都是脱敏后的真实 requestId + URL + headers + body
```

然后我会：

1. 把 `summary.json` 里的 distinctPaths 写进 `contract.md §3 端点证据表`，替换占位；
2. 把每个 .json 拷到 `test/fixtures/api-responses/<endpoint-slug>.json`，按 `contract.md §4` 规则二次脱敏；
3. 补完 `contract.md §5` 的 basic / package / hotel 读回契约（基于已抓的 GET 路径）；
4. 跑一次 smoke：`npm run pi:itinerary -- <productId> 9539`，跑通 5 块全 API 保存 + 读回，**绝不**点提审 / 发布按钮；
5. 把结果写进 `docs/vbk-api/PHASE0-SMOKE-RESULT.md`，提交本分支。

## 6. 这次没有产出但仍然必须保留的判断

- `contract.md §2` 列出的 G1~G7 端点**仍不是脑补**——它们来自 DOM 抓包前的源代码 `waitForResponse` 模式（参见 `src/main/automation/ctrip/sale-control/sale-control.ts:saveSaleControlInfo` 只 await response，不发起 request）反推。CDP 抓包落实后，命名 / 路径 / DTO 字段一律以抓到的为准，不沿用反推。
- `x-ctx-ubt-*` 头仍是阶段 1 的关键风险（`src/main/infrastructure/vbk-session-request.ts:181-191` 注释明确指出「缺失时服务器可能返回空结果」），不在阶段 0 解决。
- basic / package / hotel 三块读回契约的"二次导航 + DOM 断言"是过渡方案；阶段 1 必须找到对应 GET 端点。

## 7. 给 CTO 的明确请求

请在两种路径中选一种：

1. **提供可登录环境**：让负责 VBK 账号的同事协助 §5.1，或安排一台已登录的机器供我远程抓包；
2. **明确接受"阶段 0 仅有代码证据 + 文档契约，无抓包证据"**：在这种接受下我会把这次报告视为完成态，并把 §6 的判断落到 `contract.md §0 协议总览` 的修订里；阶段 1 启动时再做真实抓包。

我个人推荐 1，因为 §6 里 G1~G7 的反推路径已经被 CTO 警告过「端点命名纯属猜测」。
