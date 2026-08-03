# 2026-08-04 端到端测试 — 完成进展 + 剩余 Gap 清单

## 用户目标
产品从想法 → AI 配置 → VBK 后台可以上架（保存草稿，人工提审）。
上下文超过 80% 时压缩。

## 本轮完成（已 commit / 已 build）

### 1. URL pattern 升级
- `createProductShell`：接受 `/ivbk/vendor/` 路径 + `productid/productId=\d+` 参数（兼容 `baseInfoMerge` 和 `tourdays`）
- `openProductEditor`：waitForURL 同时接受 baseInfoMerge / tourdays
- 原因：VBK 已把行程描述拆到独立的 `tourdays?productid=...&istab=1` 页面

### 2. itinerary 阶段按钮改名
- `fillItineraryDraft.saveThenAdvance`：`nextButtonLabel: "提交审核并下一步"`
- 原因：VBK tourdays 页里只有「提交审核并下一步」按钮，没有「下一步」

### 3. selectStationAddress dropdown 拦截修复
- 点选项后按 Esc 关闭 dropdown（不触碰 dialog 本体），避免 force-click 后 dropdown 不自动关闭挡住下一次 click

### 4. ensureBrowserHasBounds 兜底
- 删掉 "view 宽高 > 0 就跳过" 的早退逻辑
- 总是 `setVisible(true)` 后用主窗口 size 写一次 bounds
- 同时在 `debugSnapshot` 和 `debugRunStep` 入口调用
- 解决了：renderer 没切到 stage=vbk 时 view 是 0×0，导致 click 全部超出 viewport

### 5. 测试更新
- `状态机 10`：fillItineraryDraft 允许 `nextButtonLabel: "提交审核并下一步"`（适配 VBK tourdays）
- 306/306 测过，TypeScript clean

## 本轮发现（未 commit，本轮没修完）

### Gap A. 跑道 picker UI 在跑道页面状态
- D1 (集合): 选中「接机/站」（value=3）✓
- D2 (集合): 没勾（design: 上门接/接机/站 三选一，目前是 否）  
- D2 (解散): 选中「送机/站」（value=2）✓，但「复用接机/站信息」（value="") 没自动勾
- product.operations.reusePickupForDropoff = true，但 runner 没勾第三个 checkbox
- 原因：runner 的 fillPickupAndDropoff 末尾的 `if ((await modes.count()) >= 3)` 看起来对，但运行时可能因为 DOM 状态延迟，复用 checkbox 暂时不在 DOM 里

### Gap B. itinerary 保存后弹出「请选择机场/火车站」二级 modal
- 跑道填好后点「存为草稿」会先弹「线路变更提示」（我知道了）再弹「请选择机场/火车站」
- 第二个 modal 要求「机场」「火车站」分别搜索选 VBK 城市
- runner 当前不处理这个 modal：clickSafeSave 后直接看 target tab active，会因为「active 还没到」而超时
- runner 也没保存「机场/火车站」信息到 product JSON
- product JSON 没有专门的 `departureCity.airport` / `departureCity.trainStation` 字段

### Gap C. 套餐管理 tab 解锁依赖数据完整性
- 即便 station 填好了、错误清零，套餐管理 tab 还是 disabled
- 推测还需要：行程描述完整 + 推荐理由 / 套餐 / 资源 / 价格 / 班期 各项都过 VBK 后端校验
- 单跑道填好不足以解锁

### Gap D. meal 卡片成人/儿童含餐一致性
- D1/D2 都有多个「餐饮」卡片（默认 4 张）
- VBK 要求每张卡片的「成人是否含餐」「儿童是否含餐」保持一致
- runner 没强制填这一致性，部分卡片留默认（不一致）

### Gap E. 行程描述页面 viewport 仍是 0×0
- 确保 setBounds 后 innerWidth/innerHeight 都是 1512x949
- 但弹出的 modal 里 input 的 getBoundingClientRect 还是 0×0
- 可能是 VBK 的 modal 在不同 viewport 下的 layout bug
- 可以暂时用 force:true click + 按 Esc + 多次重试绕过

### Gap F. VBK 已登录态可能随 Electron 重启丢失
- 每次重启 Electron，cookie 可能丢失
- 需要手动扫码一次才能恢复 vbk_671205 登录态

### Gap G. 测试 fixture（fixtures/station-picker.html）覆盖有限
- selectStationAddress 的集成测试只覆盖了 3 个场景
- 真实 VBK 的 selectStationAddress 还有 dropdown 拦截、Esc、force-click 等场景没测

## 测试入口
- Electron CDP: `http://127.0.0.1:$PORT`（每次启动随机 9300-9899）
- Renderer: `http://127.0.0.1:5173`
- 项目 ID: `52147893-3b1b-4746-82f3-c3e4b30c47c7`
- VBK 账号: vbk_671205（需保持登录态）

## 用户后续问题（等待用户问）
1. VBK 跳出「请选择机场/火车站」二级 modal 是不是新需求？需要把机场/火车站信息存进 product JSON 吗？
2. 复用接机/站信息的 checkbox 是否需要在 product JSON 里加 `reuseAirportTrain` 字段，还是直接 hardcode 在 runner？
3. 行程描述 4 个 meal 卡片是否都需要填（每个都填太冗余），还是只填 1 个然后删掉其他的？
4. VBK 已登录态随 Electron 重启丢失的问题，需不需要自动登录 / session 持久化？
5. 套餐管理 tab 解锁的实际前置条件是什么？是 VBK 端业务校验还是前端路由？