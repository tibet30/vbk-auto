# 2026-08-04 调试工具 + itinerary 接送站修复 — 进展交接

## 当前状态

- **项目**: `52147893-3b1b-4746-82f3-c3e4b30c47c7`（大同2天1晚私家团，productId 76522394）
- **run.status**: `failed`，currentPhase: itinerary
- **阶段状态**:
  - basic: ✅ completed
  - presentation: ✅ completed（修了 1→3 行 + 「最」字过滤）
  - itinerary: ❌ failed（`selectStationAddress` 修了但未在真 VBK 验证）
  - package / vehicleResource / preflight: pending
- **readiness**: ✅ `ready: true, completion: 100, issues: []`（presentation 通过后变绿）
- **Electron 端口**: 9837（新启动）；之前是 9539
- **VBK 登录态**: **新 Electron 启动后 cookie 已丢失**，无法直接进入 `tourdays` 页。需重新触发登录或手动扫码

## 本轮已完成

### 1. `selectStationAddress` 修复（src/main/automation/ctrip.ts）
原代码用 `dialog.getByText(city, exact: true)`，命中火车站输入框的 `ant-select-search__field__mirror` 镜像 span（不可点击），Playwright 等 30s 超时后报"tab 仍未解锁"。

修复后：从 page 根查 `.ant-select-dropdown--multiple:not(.ant-select-dropdown-hidden)` 的最后一个（火车站 portal 出去的下拉），过滤 `^${city}$` 精确匹配后点击。若没找到精确项，抛"接送站搜索「X」未返回精确选项：实际可选 ..."。

### 2. 断点执行工具链

**生产侧（Electron 主进程）**
- `src/main/automation/debug.ts` — `breakpoint(name, ctx)` / `snapshot(page)` / `resume(continue|step|stop)` / `listBreakpoints()` / `getHitBreakpoints()`。生产环境（无 `VBK_DEBUG`）全部退化为 no-op 或纯日志；`hitBreakpoints` 始终记录命中点，便于事后审计
- `ctrip.ts` 在 `selectStationAddress` 入口/options-ready/完成三个节点埋了断点
- `src/main/automation.ts` 加了 `debugRunStep / debugSnapshot / debugHitBreakpoints / debugResume / debugListBreakpoints` 五个方法
- `src/main/main.ts` 注册 `automation:debug:*` IPC
- `src/main/preload.cts` 暴露到 `window.vbk.debug`
- `src/shared/contracts.ts` 加 `VbkApi.debug` 类型

**CLI（开发者侧）**
- `scripts/debug-step.mjs` — 接收子命令：`snapshot` / `selectStationAddress` / `fillRecommendationReasons` / `fillItineraryDraft` / `run-step <name>`
- 选项：`--port N` / `--project ID` / `--cardSelector '...'` / `--city X` / `--label X` / `--json '{...}'`
- 非 TTY 默认 fire-and-forget；TTY 下显示 `> ` 提示符，`continue / step / stop / snapshot / hit / quit` 控制
- **CLI 需要 Electron 已启动并设置 `VBK_DEBUG=1`**（否则所有断点都是 no-op），也可显式 `VBK_DEBUG_BREAKPOINTS=selectStationAddress:enter,selectStationAddress:options-ready`

**测试**
- `test/automation-debug.test.ts` — 4 个单元测：production 不阻塞、断点列表解析、reset、resume 互斥
- **298/298 测过**（`npx tsx --test test/*.test.ts`）
- **TypeScript clean**（`npm run check`）

### 3. 之前保留的修复
- `fillRecommendationReasons` 1→3 行扩行（ctrip.ts 加 `appendRecommendationRow` + `RECOMMEND_APPEND_BUTTON_SELECTOR`）
- 修测试 fixture 用真实 `+` 按钮（rgb 颜色 + SVG 路径）
- product JSON：删「最」字 + 优质交通→贴心赠送
- 当前 VBK 账号补 butlerName（从 ID：1279416 复制）

## CLI 使用示例

```bash
# 单点快照
PORT=9837 node scripts/debug-step.mjs snapshot --port 9837

# 单步调用 selectStationAddress
PORT=9837 node scripts/debug-step.mjs selectStationAddress \
  --port 9837 \
  --cardSelector 'input.ant-input[placeholder="请选择"]' \
  --city 大同

# 单步调用 fillRecommendationReasons
PORT=9837 node scripts/debug-step.mjs fillRecommendationReasons \
  --port 9837 \
  --project 52147893-3b1b-4746-82f3-c3e4b30c47c7

# fire-and-forget fillItineraryDraft
PORT=9837 node scripts/debug-step.mjs fillItineraryDraft \
  --port 9837 \
  --project 52147893-3b1b-4746-82f3-c3e4b30c47c7
```

**开启真断点**：在启动 Electron 之前 export：
```bash
VBK_DEBUG=1 VBK_DEBUG_BREAKPOINTS="selectStationAddress:enter,selectStationAddress:options-ready" npm run start
```
然后跑 CLI 触发函数 — 命中断点会在 stderr 打 `[bp:name]`，交互模式下等输入。

## 下一步要做

1. **重新登录 VBK**：
   - Electron 当前 BrowserView 在 productListMerge 但 cookie 已丢
   - 路径 A：手动打开 `https://vbooking.ctrip.com` 让用户在 BrowserView 内扫码
   - 路径 B：调用 `window.vbk.browser.login()` 但之前实测 cookie 没持久化（status() 报 loggedIn 但实际跳 login）
   - **推荐手动扫码一次**，然后所有调试工具就稳了

2. **验证 selectStationAddress 修复**：登录后用 CLI 跑
   ```bash
   PORT=9837 node scripts/debug-step.mjs selectStationAddress \
     --port 9837 --cardSelector 'input.ant-input[placeholder="请选择"]' --city 大同
   ```
   期望：返回 `{ ok: true, city: "大同" }`，无 timeout 错。

3. **触发完整 itinerary retry**：
   ```bash
   PORT=9837 node -e "
   import('playwright').then(async ({chromium}) => {
     const b = await chromium.connectOverCDP('http://127.0.0.1:9837');
     const c = b.contexts()[0];
     const r = c.pages().find(p => p.url().includes('127.0.0.1:5173'));
     await r.evaluate(() => window.vbk.automation.retryPhase('52147893-3b1b-4746-82f3-c3e4b30c47c7', 'itinerary'));
     await b.close();
   });
   "
   ```

4. **继续 package / vehicleResource / preflight**：跑完后看 run.status 和 readiness

## 关键文件位置

| 文件 | 改动 |
| --- | --- |
| `src/main/automation/ctrip.ts` | `selectStationAddress` 修复 + 3 个断点埋点；`fillRecommendationReasons` 1→3 行（之前） |
| `src/main/automation/debug.ts` | **新文件**：断点 + 快照 helper |
| `src/main/automation.ts` | `debugRunStep` 等 5 个方法；import `selectStationAddress` + debug helper |
| `src/main/main.ts` | `automation:debug:*` 5 个 IPC handler |
| `src/main/preload.cts` | `window.vbk.debug.{runStep,snapshot,hitBreakpoints,resume,listBreakpoints}` |
| `src/shared/contracts.ts` | `VbkApi.debug` 接口 |
| `scripts/debug-step.mjs` | **新文件**：CLI 调试器 |
| `test/automation-debug.test.ts` | **新文件**：4 个单元测 |
| `test/recommendation-reasons.test.ts` | fixture 用真实 `+` 按钮（之前） |
| `docs/handoff/2026-08-04-recommend-section-blocker.md` | 之前 blocker 文档（已结束） |

## 提示词后续怎么用

新 session 起手时说：「接着 `docs/handoff/2026-08-04-debug-tooling.md` 继续」，重点关注：
- 端口从 9539 → 9837（CDP 不一定每次都同端口，CLI 默认 9539 但可以 `--port` 覆盖）
- 必须先在 BrowserView 里扫码登录，否则 tourdays 页跳 login
- selectStationAddress 修复已 commit 但未在真 VBK 验证
- run.status 还停在 `failed` itinerary，DB 需要清理或 retry