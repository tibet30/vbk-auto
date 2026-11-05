# POI 判定：锚点补漏 + 规则不确定时交给 AI 裁决

日期：2026-11-05
触发案例：本地产品 `37feb911-8f0c-4a73-908c-3714163bae62`（成都 4 天 3 晚私家团），毕棚沟、黄龙景区自动绑定失败，人工搜索也全部不可选。

## 背景与根因

运营原路线：

```
Day1：成都-毕棚沟-毕棚沟住宿-住：黑水
Day2：黑水-达古冰川-住：川主寺
Day3：川主寺-黄龙景区-住：九寨沟沟口
Day4：九寨沟-成都
```

携程都能查到正确 POI：毕棚沟 89964（阿坝/理县）、黄龙风景名胜区 75864（阿坝/松潘）。失败原因有两层：

1. **路线锚点漏解析**（`route-location-resolution.ts` / `numbered-route-administrative.ts`）
   - `administrativeQueryName` 去掉「住」后留下全角冒号，「住：黑水」查成「：黑水」，第 1 天缺少黑水锚点。
   - `exactRouteAdministrativeDistrict` 只接受 city/district/county，「川主寺」在平台上只有 `川主寺镇[Town]`（父级松潘、阿坝、四川），第 2、3 天缺少川主寺锚点。
   - 结果：第 1 天只剩成都锚点，第 3 天没有锚点、回落到目的地城市成都，两个景点都被判为地域不符。
2. **AI 兜底被规则限死**（`poi-auto-selection.ts`）
   - AI 只拿到「规则已认可地域」的候选。规则判错时（黄龙景区只剩成都的黄龙溪），AI 看不到正确候选。
   - 同名多候选（`ambiguous`）直接返回，不给 AI 机会。
   - 传给 AI 的上下文有 bug：`parseDisambiguateContext` 只收字符串景点，现在景点是对象，AI 拿到空路线。

## 目标

- 修掉两个锚点漏洞，让规则本身能判对这类路线。
- 规则判不了时（地域未证实、同名多候选、只召回别的景点），把**同省、身份兼容**的候选连同当天原路线、相邻锚点、邻近已核验景点和距离交给 AI 裁决。
- AI 采纳的结果留下系统凭证，后续复核、就绪检查认这条凭证，不再把它清掉或重开任务。

## 非目标

- 不改人工选择 POI 的界面与可选规则（后续可另做）。
- 不新增阻断就绪的「AI 判定需复核」提示；凭证和日志可追溯。
- 不触碰提审/发布。

## 硬门（AI 不能越过）

1. 候选必须在本次平台结果里且 `selectable`、有正 poiId。
2. 身份兼容：`isCompatiblePoiIdentity(原景点名, 候选名)`。
3. 省份已知且一致（`context.province` 或 `basicInfo.province`）；省份未知时只允许规则已认可的候选（保持现状）。
4. 营业状态不能是暂停。
5. 置信度：规则已认可地域的候选 > 0.8（现状）；规则未认可的候选 ≥ 0.9。
6. 规则未认可的候选还要有地理佐证：
   - 有当日走廊参考点且候选有坐标：距离 ≤ 2 × `ROUTE_CORRIDOR_RADIUS_KM`（160 km）。实测毕棚沟 98.5 km、黄龙 108.4 km、错误的黄龙溪 233.6 km。
   - 没有可算距离时：候选城市必须是产品任一路线锚点城市、目的地/集合城市，或候选城市/区县名出现在当天原路线里。

## 设计

### A. 锚点补漏

- `administrativeQueryName`：去掉「住/入住/前往…」前缀时一并去掉后面的冒号和空白。
- `exactRouteAdministrativeDistrict(payload, name, province?, { allowTown })`：先按原规则匹配，唯一则返回；没有时，`allowTown` 下接受唯一的 Town/Township（名称去掉「镇/乡」后与查询词一致）。
- 只有路线锚点（`resolveRouteLocations`）使用 `allowTown`。把景点改成交通节点的转换不使用：周庄、乌镇、西塘这类既是镇又是景点的名字不能被转成交通安排。
- `resolveRouteLocations` 处理 Town：城市取最靠近省份的 City 父级（阿坝），区县取最近的 City 父级（松潘）。非 Town 类型保持原逻辑。

### B. AI 裁决（新文件 `src/main/planning/poi-ai-adjudication.ts`）

`resolvePlanningPoiAutoSelection` 的新顺序：

1. 历史人工确认 → 平台 best → 同省唯一官方名（原逻辑）。同名多候选不再直接返回 `ambiguous`，而是跳过这一步交给 AI。
2. 当前有效的 AI 裁决凭证（同一天、同一景点、同一原路线 key）且该 poiId 仍在本次结果中并通过硬门 → 直接沿用，不重复调用 AI。
3. 有 `disambiguate` 时调用 AI：
   - 候选池 = 规则已认可的候选在前 + 省份已知时补充同省身份兼容的候选，去重后取前 12。
   - 候选文本：`名称 · 省/市/区 · 距当日已核验路线约 N km · 规则地域：已认可/未证实 · POI <id>`（含 poiId 保证唯一）。
   - 上下文：期望景点、第几天、当天/前一天/后一天原路线、当天行政锚点与相邻锚点、前后一天已核验景点（名称、城市、区县）、产品省份与目的地。
   - AI 调用出错时记日志，按原不确定原因返回，不把查询变成失败。
4. 过硬门后核验营业状态，返回结果。规则未认可的采纳结果带 `adjudication: { confidence, reasoning }`。

接口变更：

- `PoiAutoDisambiguator` 参数加可选 `context`，返回加可选 `reasoning`。
- `DisambiguateRequest` 加可选 `context`；提供时直接作为 `productContext`。
- `parseDisambiguateContext` 的 spot 分支改为收集景点名称（修 bug）。
- spot 专项提示词改为「按当天原路线和地理位置判断是否同一地点」，不确定就返回空串。
- 两处接线（`integration-setup.ts`、`run-planning.ts`）透传 `context` 与 `reasoning`。

### C. 裁决凭证

- 存在 `product.diagnostics.poiAdjudications`，并像 `routeLocations` 一样由 `splitProduct` 放进资源证据。AI patch 白名单不含 diagnostics，AI 写不进去。
- 结构：`{ day, spotId?, spotName, poiId, poiName, province?, city?, routeKey, confidence, reasoning, decidedAt }`。
- `routeKey = routeLocationKey(product, day)`：运营改了原路线，凭证自动失效。
- 写入：`VerifiedPoiMapping` 带上 `adjudication`，`writeResolvedItineraryPois` 在同一次 merge 里写行程和凭证。同一槽位的旧凭证被替换，已不再绑定同一 poiId 的凭证被清理。
- 读取（新文件 `src/shared/poi-adjudication-receipt.ts`）：
  - `routeLocationBlockers`：有效凭证匹配当前绑定时不报地域问题。
  - `hasDefinitePoiLocationConflict`：有效凭证匹配时不判冲突、不清绑定。
  - 自动选择第 2 步沿用凭证。

### D. 日志

- `query-no-match` 带上 `reason`。
- 新事件 `ai-adjudication`：关键词、候选数、AI 选择的 poiId、置信度、是否采纳、被哪道硬门拒绝、AI 理由。

## 我做的取舍（未与用户逐项确认）

- 规则外采纳阈值定为 0.9，距离上限定为 160 km。
- 同名多候选改为可由 AI 裁决（此前要求人工）。
- AI 出错按「不确定」处理，生成待人工核查任务，而不是按查询失败等待重试。
- 「九寨沟沟口」这类「地名 + 沟口」不做特殊处理。

## 验收

- 单测覆盖：冒号锚点、Town 锚点（含景点转换不受影响）、规则外 AI 采纳、各道硬门拒绝、凭证沿用与失效、就绪检查认凭证、AI 出错回落。
- `npm run check`、`npm test` 通过。
- 用 `/tmp` 下的真实产品快照回放：毕棚沟 → 89964，黄龙景区 → 75864。
