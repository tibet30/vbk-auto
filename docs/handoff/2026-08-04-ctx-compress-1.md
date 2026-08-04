# Compressed Context Snapshot — 2026-08-04 23:00

## Project
VBK Desktop — 旅游产品 AI 规划 + VBK 自动化录入。Electron + React + better-sqlite3 + Playwright + MiniMax。

## Current Task
Walk through all phases of 产品 from idea → VBK backend ready-to-list.
Logic: context > 80% → compress, then keep iterating.

## State
- 306/306 tests pass, TypeScript clean
- DB project: `52147893-3b1b-4746-82f3-c3e4b30c47c7` (大同2天1晚 私家团), productId=76522394, status=blocked
- run.status=failed, currentPhase=itinerary
- Electron CDP port: `/tmp/electron-port` (last 9516) — restart: `pkill -f 'electron \.'` then `nohup npm run start`
- VBK 已登录 vbk_671205 (cookie 可能随 Electron 重启丢失)
- Last commit: `d6a9162` (URL tourdays + 提交审核并下一步 + view bounds 兜底)

## Already-fixed in d6a9162
1. URL pattern: 兼容 `/ivbk/vendor/tourdays?productid=` (separate page for itinerary)
2. Button: itinerary `nextButtonLabel: "提交审核并下一步"` (no plain "下一步" on tourdays)
3. selectStationAddress: Esc after force-click closes dropdown
4. ensureBrowserHasBounds: always setVisible(true) + main window size

## Remaining Gaps (in order of priority)
- **Gap B (P0)**: itinerary save 后 VBK 弹出「请选择机场/火车站」二级 modal（机场 + 火车站 两输入），runner 不会处理
- **Gap A (P1)**: D2「复用接机/站信息」checkbox (value="") 没自动勾；runner 只勾到 modes.nth(1)=送机/站
- **Gap C (P1)**: 套餐管理 tab 仍 disabled，即使 station 填好 + 错误清零，原因不明（需 VBK 后端验证？）
- **Gap D (P2)**: 4 个 meal 卡片「成人/儿童是否含餐」需要一致
- **Gap E (P2)**: modal 里 input getBoundingClientRect 0×0，需 force click
- **Gap F (P3)**: VBK cookie 随 Electron 重启丢失
- **Gap G (P3)**: 测试 fixture 覆盖有限

## Key Files
- `src/main/automation/ctrip.ts` — VBK 自动化主逻辑（含 fillItineraryDraft / fillPickupAndDropoff / selectStationAddress / saveThenAdvance）
- `src/main/automation.ts` — DraftAutomation + debugRunStep/ensureBrowserHasBounds
- `src/main/automation/schema.ts` — product schema, pickKeySpotsFromItinerary
- `src/main/minimax.ts` — MiniMaxService + disambiguateOption
- `src/main/automation/constants.ts` — URLS, productEditorUrl (baseInfoMerge)
- `test/basic-info-fixes.test.ts` — 行为级契约（包含"状态机 10" 等）

## Key Runner Functions
- `fillItineraryDraft(page, product, options)` — itinerary 阶段（点击 → 包车 → station → meal → hotel → save → advance）
- `fillPickupAndDropoff(page, dayScope, index, totalDays, operations, extra)` — 填接送站
- `selectStationAddress(page, card, city, extra)` — 弹窗里选机场+火车站
- `saveThenAdvance(page, options)` — 通用：保存 → 等门禁（target tab active）→ 点 nextButton → 等落点

## Next Steps (priority order)
1. 处理 Gap B：在 `fillItineraryDraft` 末尾、`saveThenAdvance` 之前，加 dismissAirportTrainModal，处理「请选择机场/火车站」
2. 处理 Gap A：复用 checkbox 等待时序或 fallback
3. 测试 fillItineraryDraft 跑通
4. 推进到 套餐管理 / 价格库存 / 资源配置 / 条款维护 阶段
5. 每个新发现都补到 `docs/handoff/2026-08-04-iteration-gaps.md`

## Debug CLI
```bash
PORT=$(cat /tmp/electron-port)
node scripts/debug-step.mjs snapshot --port $PORT
node scripts/debug-step.mjs fillItineraryDraft --port $PORT --project 52147893-3b1b-4746-82f3-c3e4b30c47c7
```

## Quick Decisions for Compressed Mode
- 单步推进，不循环超过 5 次测试同一路径
- 失败立刻记录到 handoff，不重试超过 2 次
- 不要扩展新功能，只修最小缺口