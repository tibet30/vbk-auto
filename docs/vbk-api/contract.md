# VBK 录入全部走 API — 阶段 0 合同（ALNI-5）

> 维护者：高级工程师
> 状态：**blocked**（登录态不可用，详见 `PHASE0-BLOCKED.md`；本文档为代码证据层产物，**未含真实抓包**）
> 配套：`PHASE0-BLOCKED.md`（受阻报告）/ `phase0-capture/`（登录态恢复后的抓包目录）

## §0 协议总览

VBK 后端 (`*.ctrip.com` / `*.vbk.ctrip.com`) 的所有写入端点都通过浏览器 `fetch` 调用，必须保持会话完整：

- **Cookie 必须透传**：`GUID` / `vbk_login_cid` 至少其一提供 `cid`，否则服务端返回「请登录」；`UBT_VID` 注入 `x-ctx-ubt-vid`；`x-ctx-ubt-sid` 当前固定 11。
- **`head.cid` 必须写入请求体**：参考实现 `src/main/infrastructure/vbk-session-request.ts:155-160`，如果 body 已有 `head` 字段则把 cid 合并进去。
- **`x-traceID` 必须每次新生成**：格式 `<cid>-<epochMs>-<rand 0..1e7>`，后端日志用其串联请求；运行时随机化防止服务端关联。
- **18 位 ID 处理**：tourInfoId / previewTourInfoId / auditTourInfoId / draftTourInfoId / tourDaily*Id 全部必须以**字符串**形式在 JSON 里往返；`JSON.parse` 会把 16+ 位整数转 `Number.MAX_SAFE_INTEGER` 截断，参考实现里正则提前把这些字段强制包成字符串（`vbk-session-request.ts:163-167`）。
- **Ack 归一化**：业务成功 = `success === true && ResponseStatus.Ack === "Success"`，二者缺一不可；仅 Ack=Success 但 success=false 视为业务失败（参考 `src/main/automation/ctrip/presentation/save-monitor.ts` 的处理）。
- **常见请求头**（`DEFAULT_VBK_SOA_HEADERS`，`vbk-session-request.ts:55-65`）：
  ```
  accept: */*
  content-type: application/json;charset=UTF-8
  accept-language: zh-CN,zh;q=0.9
  x-ctx-currency: CNY
  x-ctx-locale: zh-CN
  x-input-locale: zh-CN  // 让 suggestPoi 返回中文行政区名（如 Gyantse → 江孜）
  ```

> **关键风险**：`x-ctx-ubt-*` 系列头（除 sid=11 与 vid=UBT_VID 外）依赖页面 JS 动态生成，**纯 fetch 无法复现**。缺失时部分接口会返回 `Ack=Success` 但 `body=[]`，这是「curl 能查到、系统查不到」的根因。阶段 0 不解决；阶段 1 必须找到可替代生成方式或注入路径。

## §1 已有 API 封装（按 6 块 + 已 stable 项）

| 阶段 | 已有端点（来源 / 函数） | 备注 |
| --- | --- | --- |
| basic-info | `suggestPoi` / `suggestDistrict` / `suggestAirport` / `suggestTrainStation` / `searchProviderContactCardList`（`src/main/infrastructure/poi-suggest*.ts`） | **缺保存**：`saveProductBaseInfo` 未在仓库出现（G1） |
| basic-info 字典 | 400 电话下拉数据源（G2）+ 地接社数据源（G3） | DOM 直读，无独立 API 封装 |
| presentation features | `bindProductImage` / `searchProductImage` / `createProductDraft` / `savedescriptioninfo` / `getdescriptionInfo` / `getpmrcmdcategory` / `checkSensitiveWord`（`src/main/automation/ctrip/presentation/save-monitor.ts`、`features.react-sync.ts`） | **features 富文本是否有独立保存端点待抓包确认**（G8） |
| package 表单 | `getPackageList`（`src/main/automation/ctrip/package-api.ts`，与 pricing 共用） | **缺保存**：`savePackageItem` 真实调用点未在仓库出现（G4） |
| pricing | `getPackageList` / `savePriceInventory` / `savePriceInventorySingleProduct` / `GetBatchOperateSchedule` / `saveAgeBandConfig` / `queryAgeBandConfig`（`src/main/automation/ctrip/pricing-api.ts`） | **dialog 触发的额外端点待抓包确认**（G5） |
| resources hotel | `searchResourceList.json`（查询，`src/main/operations/hotel-resource.ts`） | **缺保存**：`saveHotelResource` 未在仓库出现（G6） |
| resources vehicle | 已全 API（`src/main/automation/ctrip/vehicle-resource.ts`） | 不在本期 6 块范围 |
| sale-control | **仅响应拦截**：`page.waitForResponse(/saveSaleControlInfo/)` 在 `src/main/automation/ctrip/sale-control/sale-control.ts`——**没有 `page.request.post` 发起方**，DTO 字段不可知（G7） | 阶段 1 必须抓到发起端点 + 完整 DTO |
| itinerary / terms / clauses | 全 API（`src/main/automation/ctrip/itinerary-api/`、`structured-clauses-api.test.ts`、`structured-terms-contract.test.ts`） | 不在本期 6 块范围 |
| 公用 | `vbkSessionRequest`（`src/main/infrastructure/vbk-session-request.ts`） | 唯一「浏览器内 fetch」封装，统一处理 cookie / cid / UBT / 18 位 ID / Ack |

## §2 缺口清单（必须在阶段 1 抓到真实请求 / 响应后才能填命名 / 路径 / DTO）

| ID | 用途 | 现入口（DOM 反推） | 抓包命令模板 |
| --- | --- | --- | --- |
| G1 | 保存基本信息 | basic-info 「保存」按钮 | 打开 basic 页 → 改一个字段 → 点保存 → 抓 `**/save*BaseInfo*` 或 `**/baseInfoMerge/save*` |
| G2 | 400 电话下拉数据 | basic-info 「400 电话」select | 点开 select → 抓 `**/*phone*List*` / `**/*Phone*` |
| G3 | 地接社下拉数据 | basic-info 「地接社」select | 同上 → 抓 `**/*agency*` / `**/*LandOperator*` |
| G4 | 保存套餐 | packageManage 「保存套餐」按钮 | 改套餐项 → 点保存 → 抓 `**/savePackage*` / `**/PackageItem*save*` |
| G5 | pricing dialog 触发的端点 | pricing 「添加价格」dialog 「确定」 | 抓 dialog 内任意「添加」「删除」「保存」触发的 POST |
| G6 | 保存酒店资源 | hotelResource 「保存」 | 改一个资源 → 点保存 → 抓 `**/saveHotel*` / `**/HotelResource*save*` |
| G7 | 保存销售控制 | sale-control 「保存」 | **注意仓库现状**：只 await response 不发 request，抓包**前**必须先找到 DOM 上哪个按钮触发的 fetch |
| G8 | features 富文本独立保存端点（如有） | presentation features 富文本编辑 | 在 features 区域改 → 抓 `**/*feature*` POST；如抓到 `/15638/savedescriptioninfo` 内嵌 features，则 G8 不存在 |

**重要约定**：上表命名/路径是 DOM + URL 关键词反推，**不是真实端点**。登录态恢复后必须以抓包为准。

## §3 端点证据表（占位 — 登录态恢复后由 `phase0-capture/summary.json` 回填）

| 阶段 | URL | 方法 | requestId | DTO 摘要 | fixture |
| --- | --- | --- | --- | --- | --- |
| （待回填） | — | POST | — | — | `test/fixtures/api-responses/<slug>.json` |

## §4 脱敏规则（写 fixture 前必过）

1. **凭据字段**：`GUID` / `vbk_login_cid` / `UBT_VID` / `vbkticket` / `bticket` / `JSESSIONID` / `vbk-menu-business-id` / `_bfa` / `Authorization` / `Cookie` / `Set-Cookie` / `x-traceID` / `x-ctx-ubt-vid` / `x-ctx-ubt-sid` / `cid` / `_fxpcqlniredt` → `[REDACTED]`。
2. **值模式**：手机号 `1[3-9]\d{9}`、身份证 `\d{17}[\dXx]`、tourInfoId 系 16+ 位数字 → `[REDACTED]`。
3. **业务 ID 字段**：`tourInfoId` / `previewTourInfoId` / `auditTourInfoId` / `draftTourInfoId` / `tourDaily*Id` **保留字段名与位长**，但具体值置为 `tourInfoId-stub-{section}-{index}`，便于回放比对。
4. **图片 / 文件 URL**：仅保留 host 与 path 前两段，query 全部 `[REDACTED]`。
5. **个人姓名 / 地址**：保留字段名，值 `[REDACTED]`。

fixture 落盘前 grep 检查：
```bash
grep -REn "GUID|UBT_VID|vbk_login_cid|xsid|contactCardId=[0-9]{8,}|imageId=[0-9]{8,}|tourInfoId=[0-9]{18,}|手机|电话|身份证|姓名|护照" \
    docs/vbk-api/phase0-capture test/fixtures/api-responses
# 命中行必须是字段名引用，不是凭据值
```

## §5 读回校验门禁清单（阶段 1 必跑）

| 阶段 | 已有独立 GET | 读回手段 | 阶段 1 要求 |
| --- | --- | --- | --- |
| itinerary | `getTourDailyDetail` 等 | API 读回 | ✅ 已稳定 |
| presentation | `getdescriptionInfo` | API 读回 | ✅ 已稳定 |
| pricing | `getPackageList` / `queryAgeBandConfig` | API 读回 | ✅ 已稳定 |
| vehicle resource | 资源列表 API | API 读回 | ✅ 已稳定 |
| terms / clauses | 资源条款 API | API 读回 | ✅ 已稳定 |
| **basic-info** | ❌ 无 | 二次导航 + DOM 断言 | **必补**：找 GET 端点，否则阶段 1 smoke 无法断言基本信息真的写入 |
| **package** | `getPackageList` 只覆盖 pricing | 二次导航 + DOM 断言 | **必补**：套餐项 ID 列表 GET 或返回 tourInfoId 下所有 package |
| **hotel resource** | `searchResourceList.json`（搜索） | 搜索 API + 二次进入断言 | **必补**：拿到 hotelResourceId 后必须能回查资源详情 |

## §6 完整草稿 smoke（不触发提审 / 发布）

```
1. 启动 chromium + 持久化 profile（已注入 vbkticket）
2. 打开 productListMerge → 抓第一条 productId
3. 调 G1 改基本名 → 保存 → 二次导航断言新名生效
4. 调 G2 / G3 选 400 电话 + 地接社 → 保存 → 列表断言
5. 调 G6 选一个酒店 → 保存 → searchResourceList 回查 hotelResourceId
6. 调 G4 添加一个套餐项 → 保存 → G5 触发的端点全部走完
7. presentation features 改富文本 → 调 savedescriptioninfo → 读 getdescriptionInfo
8. sale-control 改一个开关 → G7 保存 → 二次打开验证
9. 全程禁止触发「提交审核」「发布」按钮；任何按钮带「提交」「发布」「上线」字样的抓 hover 后立即跳过
10. 任何步骤出现 Ack=Success 但 body=[] 即视为失败，停止 smoke 并报告根因
```

## §7 风险表

| 风险 | 后果 | 缓解 |
| --- | --- | --- |
| `x-ctx-ubt-*` 头缺失 | suggestPoi 等接口返回空数据 | 阶段 1 抓包时同时打印 request headers，找服务器接收的 ubt 系列头生成路径 |
| 18 位 ID 走 JSON.parse 被截断 | tourInfoId 末位变 0 | 已通过正则提前字符串化（`vbk-session-request.ts:163-167`） |
| ticket 过期 / profile 损坏 | 抓不到任何端点 | `PHASE0-BLOCKED.md §2.2` 已暴露现状，需人工协助 |
| saveSaleControlInfo 没发起方 | 阶段 1 G7 无法抓包 | 抓包前先在 DOM 上 trace 哪个事件调用了 fetch |
| 套餐 / 酒店读回无 GET | smoke 写入无法验证 | §5 已列阶段 1 必补 |

## §8 阶段 0 门禁清单（CTO 验收项）

| 验收项 | 状态 | 备注 |
| --- | --- | --- |
| §2 G1~G7 抓包记录 + requestId 回填 §3 | ❌ | 等登录态恢复；`phase0-capture/` 目录已建好 |
| §3 每个端点脱敏 fixture 路径 | ❌ | `test/fixtures/api-responses/` 已建，文件待落 |
| §4 grep 泄密检查 0 命中 | ✅ | §4 命令模板已写，落盘前再跑 |
| §5 读回校验清单 ≥ 4 项可执行 | ✅ | itinerary / presentation / pricing / vehicle / clauses 已列 |
| §5 标缺项给 basic / package / hotel | ✅ | 已写明阶段 1 必补要求 |
| §6 smoke 跑通 1 个完整产品 | ❌ | 等登录态恢复 |
| 合同文件落在项目资源 | ✅ | 本文件已 commit 到 `agent/agent/4c3eefc76125` 分支 |
| 失真 phase0 元数据清理 | ✅ | `PHASE0-BLOCKED.md §4` 已说明 |
| 登录态不可用时报告命令 + 错误 + 人工动作 | ✅ | `PHASE0-BLOCKED.md §2 + §5` |
