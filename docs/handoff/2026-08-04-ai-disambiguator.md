# 2026-08-04 AI 歧义消除接入 + 数据风险跳过 + 当前页面重试 — 进展交接

## 用户这一轮的三条核心建议

1. **景点 / 城市 / 车站输入要精确** — 不确定时让 AI 决断。
2. **报错后改几次还不符合预期时，重新明确问题、获取全上下文、判断应该输入什么、应该得到什么**，再动手。
3. **遇到问题不要每次都从第一个页面开始。我们可以在当前页面去重试。**
4. **添加景点如果遇到「数据风险 … 朝鲜 … 境内短途旅游」弹窗，直接跳过该景点**。

## 当前状态

- 项目 `52147893-3b1b-4746-82f3-c3e4b30c47c7`（大同2天1晚）
- run.status: failed，currentPhase: basic
- basic 阶段最近一次失败：phone400 combobox 点击超时（根因：WebContentsView 在自动化被跨进程触发时
  bounds 还没由 renderer ResizeObserver 上报 → window.innerHeight=0 → Playwright auto-scroll 跟不动
  → click 30s 超时；下一轮应当跑「兑底 setBounds」让 view 填满主窗口，phone400 滚动到视野中央）
- 之前 progress：presentation 修过且 verified OK（1→3 行 + 「最」字过滤 + butlerName 复制）
- VBK 页面：baseInfoMerge?productId=76522394&from=vbk（verified）

## 这一轮已完成

### 1. 景点输入净化（schema.ts）
- `pickKeySpotsFromItinerary` 去除「游览/参观/参观游览/游览参观」后缀
- 过滤「接团/送团/送机/接机/返程/出发/报到/入住/退房/自由活动」等非景点词
- 实测：大同行程现在返回 `['云冈石窟', '华严寺', '九龙壁']`（之前会返回 `'云冈石窟游览'`）
- 加了 2 个测试覆盖净化行为

### 2. AI 歧义消除基础设施 + 集成

**contracts.ts**
- `DisambiguateRequest { kind, desired, product, candidates[] }`
- `DisambiguateOutcome { pickedText, reasoning }`

**minimax.ts**
- `MiniMaxService.disambiguateOption(input)` — 用 `submit_disambiguation` tool 让 AI 选最像的项
- `disambiguateTool`（function tool schema）
- `disambiguateOutcomeSchema`（zod 校验）
- `disambiguateSystemPrompt(kind)` — 按 kind 给出专项约束（province / city / spot / station）
- `extractContextForKind(product, kind, desired)` — 抽产品 JSON 里跟该 kind 相关的字段给 AI 看
- **prompt 强化**：city / spot / station 都明确写「不要选朝鲜-/北朝鲜-/韩国-/日本- 等境外前缀」；
  优先选「中国-xxx」；spot 进一步要求「只在国内景点里选，遇到境外候选返回空串」

**main.ts**
- `DraftAutomation` 构造函数加第 5 个参数 `disambiguator`
- 调用点同时接 advisor + disambiguator，两者都用同一个 `MiniMaxService` 实例
- 5 个新 IPC：`automation:debug:runStep / snapshot / hitBreakpoints / resume / listBreakpoints`
- `DraftAutomation.debugRunStep` 支持 `snapshot / selectStationAddress / fillItineraryDraft / fillRecommendationReasons` 四个具名步骤
- `DraftAutomation.debugSnapshot / debugHitBreakpoints / debugResume / debugListBreakpoints` 配合 `scripts/debug-step.mjs` 交互式断点

**automation.ts**
- `DraftAutomation` constructor 接受 disambiguator 参数
- `handlers.basic` 把 `disambiguator` 塞进 extra 传给 `fillAndSaveBasicInfo`
- `handlers.itinerary` 把 `disambiguator` 作为 options 传给 `fillItineraryDraft`

**ctrip.ts**
- `matchDropdownOption(candidates, disableds, aliases, context, disambiguator)` 新 helper：
  - 先按 aliases 精确匹配（多数 case 一步命中）
  - 失败时调 disambiguator
  - **过滤境外前缀**：candidates 文本里含「朝鲜-/北朝鲜-/韩国-/日本-/蒙古-/俄罗斯-」前缀的项不发给 AI（确定性兜底）
  - 二次校验 AI 选中的文本必须在原 candidates 中、非 disabled；否则返回 null 让上游走原报错
  - AI 抛错 catch 后降级到原报错路径，不会拖崩上游
  - 唯一可能不确定的 case 是「disabled 但候选仅 1 项」 → 视为无可用候选返回 null
- `fillScenicAreaProvince` 接 disambiguator，provinces 命中失败时 AI 兜底
- `fillScenicAreaSpots` 的 `chooseExact` 接 disambiguator，超时轮询后 AI 兜底
- `fillCitySelect` 接 disambiguator，pickCityOption 返回 `ambiguous / missing:wrongCountry` 时 AI 兜底
  （exact match 阶段：preferredCountry="中国" 时，aliases 包含 `中国-${city} / ${city} / ${city}市`，会优先命中
  「中国-大同」一类带国家前缀的项；不命中才让 AI 决定）
- `selectStationAddress` 接 disambiguator，exact regex `^${city}$` 失败时 AI 兜底
  （aliases 包含 `${city} / ${city}站 / ${city}南站 / ${city}北站 / ${city}东站 / ${city}西站 / ${city}机场`，
  让 AI 选最像的车站/机场）

### 3. 数据风险弹窗处理（**用户新增需求**）

**dismissDataRiskDialog(page, timeoutMs?)** 新 helper
- 检测文本含「数据风险」的弹窗（典型：「数据风险，原因：途径地：朝鲜 且 产品类型：境内短途旅游」）
- 点「我知道了 / 知道了 / 确定 / 关闭」关闭
- 返回弹窗文本或 null

**fillScenicAreaProvince**
- 点完「添加」后调 `dismissDataRiskDialog`；命中就抛明确错（省份是必填，AI 选境外项是严重 bug）
  错误：「省下拉疑似选中了境外项：<dialog>。这是 VBK 的阻断式反馈，请检查 VBK 中是否手动选过其他国家的省份。」

**fillScenicAreaSpots**
- 点完「添加」后调 `dismissDataRiskDialog`；命中就 log `[warn]` 并 `continue`（按用户要求跳过该景点）
- 提交后 8s 等待循环里也轮询一次，避免「先添加后弹窗」的延迟场景
- 等待循环结束后再做一次兜底检测

**测试**
- basic-info-fixes.test.ts 加了 `assert.match(body, /dismissDataRiskDialog/)` + `assert.match(body, /数据风险弹窗.*跳过该景点/)`

### 4. 当前页面重试偏好（**用户新增需求**）

用户：「遇到问题，不要每次都是从第一个页面开始。我们可以在当前页面去重试。」

**applyAction 全 Noop**（recovery.ts 不变，automation.ts 改）
- `retry_same_phase / reload_and_retry_phase / reopen_editor_and_retry_phase` 三者一律 noop
- 仍记录 advisor 诊断到 attemptsHistory 给下次会话接手
- `wait_for_user` 仍由 runner 提前 stop，不会到 applyAction
- 日志：`applyAction noop action=${action} phase=${phase}（当前页面重试偏好）`

**openProductEditor 新选项 `stayOnCurrentTab`**
- 默认 `false`：保持原行为（同产品时 `ensureBasicInfoTabVisible` 点回「基本信息」tab）
- `true`：同产品时直接 return，不点「基本信息」tab
- 各阶段 handler 自己负责切 tab（fillItineraryDraft 已有 `if (titleInputs count != expected) clickSection("行程描述")`）

**run() 的 else 分支改用 stayOnCurrentTab=true**
- 旧逻辑：`openProductEditor(page, productId!)` + 「重试 ${retryFrom} 前…」日志
- 新逻辑：`openProductEditor(page, productId!, { stayOnCurrentTab: true })` + 「已从 ${retryFrom} 阶段继续录入（当前页面）」日志
- 删掉旧的「重新录入产品信息」隐含承诺（实际上 else 分支从来没真的在重填 basic）

**run() 跳过 basic 段（startIndex > 0 时）**
- 旧：`runPhaseWithRecovery(makeCtx("basic", basicExecute, 0))` 无条件调用
- 新：仅 `startIndex === 0` 时调 basic runner；`startIndex > 0` 时 log「跳过 basic 阶段（已保存），从 ${retryFrom} 继续（当前页面重试）」
- 中间阶段重试不再强制跑 basic，信任已保存；handler 各自切 tab

**测试**
- `retryFrom>0 也由 basic runner 包裹，else 不再直接 fillAndSaveBasicInfo/setBasicInfoSaved` 已更新到新行为
- 新断言：`openProductEditor\(page, productId!,\s*\{\s*stayOnCurrentTab:\s*true\s*\}\)` 在 else 块
- 新断言：`/跳过 basic 阶段（已保存）/` 在 `if (startIndex > 0)` 分支

### 5. 调试 / 提早发现问题（重试之前先 dump）

- `scripts/debug-step.mjs` 已有
  - `snapshot`：拉当前 VBK 页面 DOM 摘要
  - `selectStationAddress --cardSelector '…' --city 大同`：单步复现接送站
  - `fillItineraryDraft --project <id>`：单步跑整个 itinerary handler
  - `run-step <name> --json {...} --break beforeXxx` 走通用 debug 入口
- 交互模式：TTY 下可 continue / step / stop / hit / snapshot / help

### 6. phone400 自动滚动 / 视野保障

**根因**：Electron WebContentsView 跨进程触发 automation 时（autonomous-runner / CLI / 外部
重试按钮），renderer 还没上报 ResizeObserver → view bounds=0×0 → window.innerHeight=0
→ Playwright auto-scroll 跟不动 → click 等 30s 超时。

**两层防护**：
- `DraftAutomation.ensureBrowserHasBounds()`（run 入口处调用）：
  - 查 `browser.view.getBounds()`，若 width/height 任一为 0 → 取 `BrowserWindow.getAllWindows()[0].getSize()`
    调 `browser.setBounds({x:0, y:0, width, height})` 填满主窗口
  - 这是 fallback，renderer 已上报的 bounds 不覆盖
- `fillServicePhone` 内加 `scrollIntoView` 兑底：
  - 用 `el.scrollIntoView({block:'center', behavior:'instant'})`
  - 接着手写 `form.scrollTop` 与 `main.scrollTop = max(0, offsetTop - clientHeight/2)` 处理
    滚动原点在 form 容器 / main 容器上的场景

## 测试 / 验证

```bash
npm run check
npx tsx --test test/*.test.ts        # 300/300 过
npm run build                          # clean
# 重启 Electron 后看（端口会随机 9300+0..600）
node scripts/debug-step.mjs snapshot --port 9367
node scripts/debug-step.mjs selectStationAddress --port 9367 --cardSelector '…' --city 大同
# 触发完整 retry（current page 偏好）
node -e "
import('playwright').then(async ({chromium}) => {
  const b = await chromium.connectOverCDP('http://127.0.0.1:9367');
  const c = b.contexts()[0];
  const r = c.pages().find(p => p.url().includes('127.0.0.1:5173'));
  for (const p of c.pages()) {
    try { p.removeAllListeners('dialog'); } catch {}
    p.on('dialog', d => d.accept().catch(()=>{}));
  }
  await r.evaluate((id) => window.vbk.automation.retryPhase(id, 'basic'), '52147893-…');
  await b.close();
});
"
```

## 关键文件状态

| 文件 | 状态 |
| --- | --- |
| `src/shared/contracts.ts` | ✅ 加了 `DisambiguateRequest/Outcome` |
| `src/main/minimax.ts` | ✅ 加了 disambiguate + prompt 强化（不要选朝鲜/海外） |
| `src/main/automation.ts` | ✅ disambiguator 第 5 参、applyAction noop、openProductEditor stayOnCurrentTab、ensureBrowserHasBounds、startIndex>0 跳过 basic |
| `src/main/main.ts` | ✅ 5 个 debug IPC + disambiguator 注入 |
| `src/main/preload.cts` | ✅ 5 个 debug 接口暴露 |
| `src/main/automation/ctrip.ts` | ✅ `matchDropdownOption` / `dismissDataRiskDialog` 2 个新 helper；fillAndSaveBasicInfo / fillItineraryDraft / fillScenicAreaProvince / fillScenicAreaSpots / pickCityOption / selectStationAddress 全部接 disambiguator + data risk 处理 + phone400 scroll-into-view；openProductEditor 支持 stayOnCurrentTab |
| `src/main/automation/schema.ts` | ✅ pickKeySpotsFromItinerary 净化 |
| `src/main/automation/debug.ts` | ✅ 已有 breakpoints / snapshot / resume |
| `test/basic-info-fixes.test.ts` | ✅ fillCitySelect preferredCountry 断言放宽、else 块断言更新到新行为、数据风险断言 |
| `test/recommendation-reasons.test.ts` | ✅ + 行渲染断言 |
| `test/automation-recovery.test.ts` | ✅ 11/11 过（用 mock applyAction，不依赖实际 reload） |
| `dist-electron/main/*` | ✅ npm run build 已同步；重启 Electron 后生效 |

## 当前失败点 + 建议下一步

1. **phone400 自动滚动**：已加 scrollIntoView + ensureBrowserHasBounds；下一轮跑 basic 阶段应能过。
   如果还失败：先 `node scripts/debug-step.mjs snapshot` 看页面状态，**不要凭假设改代码**。
2. **数据风险弹窗**：fillScenicAreaSpots 选「云冈石窟」如果仍被 AI 误判成「朝鲜-云冈石窟」，
   会触发数据风险弹窗 → 自动跳过该景点。下一轮跑 basic 时景点选择会跳过「云冈石窟」，
   跑完后日志里会有 `[warn] 景点"云冈石窟"添加触发数据风险弹窗`。
3. **AI 兜底成本**：所有 4 个 helper 都优先 exact match；只有「精确匹配全失败」时才调 AI，
   单产品预计 0-2 次 AI 调用。providerId 提示里也已写「不要每条都问 AI」。
4. **disambiguator 与 advisor 复用同一个 MiniMaxService 实例** — key / model 失效时两者都会
   失败并由 runner 走 wait_for_user；不会让一个失败导致另一个异常。

## 提示词后续

新 session 起手：「接着 `docs/handoff/2026-08-04-ai-disambiguator.md` 继续做基本阶段重试」。
重点：
- 重启 Electron 后端口会变（9300+0..600），先用 `lsof -iTCP -sTCP:LISTEN -P | grep electron` 查
- phone400 错误先 `snapshot` 拿 DOM，再决定改什么
- 数据风险弹窗已自动处理，无需手动干预
- 中间阶段重试不会再跳回「基本信息」tab，信任 basic 已保存
