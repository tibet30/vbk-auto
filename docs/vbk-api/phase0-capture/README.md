# vbk-api phase 0 capture — 产品 ID 占用表

阶段 1 的 6 个并行子任务 (A~F) 必须各自在 VBK 产品列表的「无效 / 回收站 / 草稿」tab 下挑选**互不相同**的 productId,严禁在同一 productId 上并发写。先登记者先得,登记后请直接 claim 自己的行。

> 分配口径:本仓 CTO (高级工程师-1) 已拍板全部走 **CDP 9501**(复用 高级工程师-2 已就绪的登录态,无重复扫码)。所有 subagent 通过 `VBK_CDP_PORT=9501` 各起独立 `browser.newContext()`(Electron remote-debugging 端口不支持创建 context,实际用 `contexts()[0]` 复用 + 新开 `newPage()`,符合"独立标签页、不共享 page state"的护栏)。

## 选定池 (源:CDP 9501 + VBK 「无效(3307)」 tab)

下列 20 条 productId 全部来自今天 2026-08-29 通过 CDP 抓取的产品列表,**审核状态 = 产品尚未审核通过,产品状态 = 下线**。这是 VBK 体系内最接近"测试草稿"的状态 — 不会被任何外部门店看见,也绝不构成误提审风险。

```
77723262  自由行境内短途旅游   (无商家名,纯粹空白草稿 — 推荐给 A/B 作为最小测试面)
77723128  VBK-安思科-20260829014844734-P77723128-北京2天1晚自由行
77689621  FW——陈志彤 — 陕西安康+石泉3日2晚自由行
77689461  FW——陈志彤 — 陕西西安+宝鸡4日3晚自由行
77659342  VBK-安思科-20260827084054865-P77659342-北京2天1晚跟团游
77634579  VBK-安思科-20260829013114078-P77634579-北京2天1晚半自助游
77631395  VBK-安思科-20260827023049064-北京2天1晚半自助游
77629068  VBK-安思科-20260827015401303-北京2天1晚私家团
77622612  VBK-安思科-20260826152720728-成都2天1晚私家团
77621030  VBK-安思科-20260826113834981-三亚2天1晚私家团
77620967  VBK-安思科-20260826113822999-昆明2天1晚自由行
77620535  VBK-安思科-20260826113811965-桂林2天1晚跟团游
77619836  VBK-安思科-20260826113801556-长沙2天1晚半自助游
77618407  VBK-安思科-20260826113741680-武汉2天1晚半自助游
```

## 子任务分配 (登记占位,subagent 开工后回填 owner / worktree / 起始时间)

| 子任务 | 调研范围 | 分配 productId | owner / worktree | 起始时间 |
| --- | --- | --- | --- | --- |
| **A. basic-info 保存线** | G1 `saveProductBaseInfo` + G2 400电话数据源 + G3 地接社数据源 | `77723128` (北京自由行) | subagent-A (待派) | 待定 |
| **B. presentation features 富文本** | G8: presentation/features 富文本保存端点 / 是否内嵌于 `savedescriptioninfo` | `77659342` (北京跟团游) | subagent-B (待派) | 待定 |
| **C. package 套餐保存** | G4 `savePackageItem` + 套餐项 ID GET 路径 | `77634579` (北京半自助游) | subagent-C (待派) | 待定 |
| **D. pricing dialog 端点** | G5: pricing 「添加价格/添加/删除/批量」触发 POST | `77631395` (北京半自助游 v2) | subagent-D (待派) | 待定 |
| **E. resources hotel 保存** | G6 `saveHotelResource` + hotelResourceId 回查 | `77629068` (北京私家团) | subagent-E (待派) | 待定 |
| **F. sale-control 保存** | G7: DOM 上 trace fetch 发起方再触发;**最不确定的一块**,预留备用 ID | `77622612` (成都私家团) | subagent-F (待派) | 待定 |

> **备用池**(任意子任务需要换 productId): `77621030` (三亚)、`77620967` (昆明)、`77620535` (桂林)、`77619836` (长沙)、`77618407` (武汉)、`77723262` (空白草稿,推荐作 readback-only fixture 抓取)。

## 抢占规则

1. subagent 开工前**必须**先 `cat docs/vbk-api/phase0-capture/README.md`,确认自己的 productId 未被别人占用。
2. 用同一 productId 必须先在表格里 mark `in_progress` + owner + 起始时间;撤回时 mark `released`。
3. 严禁跨子任务在**同一 productId 上并发抓保存端点**(同一 VBK 后端会话只能允许 1 个写者)。
4. 抓取完成后,对应行换成 `done (commit XXXXXXX)` 并附 commit 链接。

## 与已有截图的关系

`phase0-list-fail.png` / `phase0-list-probe.png` 是上一轮阶段 0 阻塞报告中的两张物证,保留以便对照"登录态恢复前 vs 恢复后"的差异(恢复后已能正确渲染 antd table,见 `01a04b5a-b455-7423-acae-7fbd0ad54496` 验证快照 `.data/logs/vbk-login-verify.json`)。
