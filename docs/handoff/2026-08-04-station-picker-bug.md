# 2026-08-04 接送站选择修复 — 进展交接

## 当前状态

- 项目：`52147893-3b1b-4746-82f3-c3e4b30c47c7`（大同2天1晚私家团，productId 76522394）
- 阶段：itinerary 之前一直 `failed`，`selectStationAddress` 修了但未在真 VBK 验证
- 本轮：**3 个 bug 全部修复并加锁测试**
- 端口：9750（Electron 仍在跑老版本，需要重启才生效）
- VBK 登录态：上一轮已登录；Cookie 仍有效

## 本轮修复的 3 个 bug

### 1. 索引错位（最严重）

**症状**：机场字段从未被填；火车字段 30s 超时报错。

**根因**：弹窗只有 2 个 `<input>`（airport 搜索框 + train 搜索框），但旧代码
按"有隐藏 input，索引从 1 起"假设写了 `fillStationField(1, "airport")` 和
`fillStationField(2, "train")`：
- `fillStationField(1, "airport")` → 实际点到的是 **火车搜索框**，把
  "大同" 输到了火车字段，机场字段没动。
- `fillStationField(2, "train")` → `inputs.nth(2)` **越界**（实际只有
  2 个），Playwright 30s 超时。

**修复**：`fillStationField(0, "airport")` 和 `fillStationField(1, "train")`。
证据：手测 `dialog.locator("input").count() === 2` 始终成立。

### 2. closeBlockingDialogs 自关弹窗

**症状**：dropdown 出现后还没点就被关掉，元素"not visible"超时。

**根因**：`fillStationField` 内部 7 次调用 `closeBlockingDialogs` 试图清掉
可能挡路的其它遮罩弹窗。但函数本身运行在接送站弹窗内部；
`closeBlockingDialogs` 按 `role="dialog"` 枚举并尝试点 "确定" 关闭，
结果把接送站弹窗自己关掉。

**修复**：函数内禁止调 `closeBlockingDialogs`；改用
`collapseOverlayTooltips()`（只按 Esc 收 tooltip/popover，不动弹窗本身）。

### 3. AI 兜底合约错位

**症状**：dropdown 有多个候选项时，AI 永远不命中，落入 `no-match`。

**根因**：原代码期望 disambiguator 返回 `{index, reasoning}`，但实际新签名
是 `{pickedText, reasoning}`。`aiMatch.index` 永远 undefined，
`candidates[undefined]` 也 undefined，整条 if 直接 false。

**修复**：AI 兜底兼容两种合约：
- `{index, ...}` 老调用方 — 直接用
- `{pickedText, ...}` 新调用方 — 在 candidates 里定位 pickedText 对应索引
定位后还要校验 `disableds[idx] === false` 才点。

## 测试覆盖

| 测试 | 路径 | 覆盖什么 |
| --- | --- | --- |
| 索引契约 | `test/select-station-index-bug.test.ts` | 锁死 airport=0/train=1；任何回归（注释写错、索引写错、inputs.nth(2) 出现）立刻失败 |
| 集成端到端 | `test/select-station-integration.test.ts` | 用 `fixtures/station-picker.html` 跑真实 `selectStationAddress` 函数，覆盖：①单一机场+精确火车 ②多项+AI 兜底 ③弹窗不被自关 |
| helper 契约 | `test/basic-info-fixes.test.ts` | 把"closeBlockingDialogs 必须存在"改为"selectStationAddress 内部不允许再调 closeBlockingDialogs" |
| 旧跑通 | `test/*.test.ts` | 303→306 个测试，全过 |

跑测试：
```bash
npx tsx --test test/*.test.ts
# 1..306
# # tests 306
# # pass 306
# # fail 0
```

## 真 VBK 验证步骤

1. 重启 Electron（端口 9750 当前是旧代码，需要重启加载新 dist-electron）
   ```bash
   pkill -f 'electron .' 2>/dev/null || true
   npm run start &
   ```

2. 在 BrowserView 内扫码登录 VBK（cookie 仍在的话可能不需要）

3. 进到 itinerary tab，点"接机/站地址"输入框打开弹窗

4. 调试 CLI 跑单步：
   ```bash
   PORT=9750 node scripts/debug-step.mjs selectStationAddress \
     --port 9750 \
     --cardSelector '[class*="td-day-card--"]:has(label:text("接机/站地址"), div:text("接机/站地址"), span:text("接机/站地址"))' \
     --city 大同
   ```
   预期：返回 `{ok: true, city: "大同"}`，机场 = "大同云冈国际机场"、火车 = "大同"。

## 关键文件

| 文件 | 改动 |
| --- | --- |
| `src/main/automation/ctrip.ts` | `selectStationAddress` 3 bug 修复（索引、closeBlockingDialogs、AI 合约） |
| `fixtures/station-picker.html` | 新增 — 模拟 VBK 接送站弹窗 DOM 的本地测试页 |
| `test/select-station-index-bug.test.ts` | 新增 — 锁死索引契约 |
| `test/select-station-integration.test.ts` | 新增 — Playwright 跑 fixture 端到端 |
| `test/basic-info-fixes.test.ts` | 改"closeBlockingDialogs 在 selectStationAddress 内部"旧契约 |
