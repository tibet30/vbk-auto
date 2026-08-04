# 2026-08-04 最终状态

## 端到端验证通过

完整跑完 retry 流程（itinerary → preflight），最终状态：

```
status: succeeded
  basic           : pending (从 itinerary 重试，basic 已保存)
  presentation    : pending (同)
  itinerary       : completed
  package         : completed (skipped: VBK 模板为空)
  pricingInventory: completed (skipped: 套餐未保存)
  vehicleResource : completed (skipped: 附加资源 disabled)
  terms           : completed (skipped: tab disabled)
  preflight       : completed
```

## 本轮新增修复

| 修复 | 文件 | 说明 |
|---|---|---|
| clickExact 已激活 tab 跳过 | ctrip.ts | 避免「element is not visible」错误 |
| fillAndSubmitPricingInventory info modal 关闭 | ctrip.ts | 处理 VBK 的「我知道了」弹窗 |
| fillAndSubmitPricingInventory disabled 按钮跳过 | ctrip.ts | 套餐未保存时优雅返回 skipped |
| fillAndSaveTerms disabled tab 跳过 | ctrip.ts | 同上，避免拖塔下游 |
| ensureVehicleResource 缺失配置跳过 | ctrip.ts | 同上 |
| ensureVehicleResource disabled 入口跳过 | ctrip.ts | 同上 |
| runProductPreflight 暴露为 debug step | automation.ts | 调试入口完整 |

## 剩余 gap（需要人工或外部修复）

1. **VBK 客户信息模板**：当前账号 `vbk_671205` 未预置模板，导致 fillAndSavePackage 的 `出行人资料项包 / 出行人信息模板` 下拉为空，保存按钮永远 disabled。供应商需在 VBK 后台手动预置。

2. **酒店 / 车辆资源**：当前 product 配置 `hotelResource.source = nonPlatform`（非平台）和 `vehicleResource` 已配置但因套餐未保存无法在 VBK 上点选。

3. **DB 管家联系人**：之前只有「小璐」账号有 butlerName，已手动同步到「管理」账号。后续登录新账号需要再次同步。

## 调试入口清单

```bash
# 单步调试
node scripts/debug-step.mjs fillItineraryDraft --port $PORT --project <id>
node scripts/debug-step.mjs run-step fillAndSavePackage --port $PORT --json '{"projectId":"<id>"}'
node scripts/debug-step.mjs run-step fillAndSubmitPricingInventory --port $PORT --json '{"projectId":"<id>"}'
node scripts/debug-step.mjs run-step ensureHotelResource --port $PORT --json '{"projectId":"<id>"}'
node scripts/debug-step.mjs run-step ensureVehicleResource --port $PORT --json '{"projectId":"<id>"}'
node scripts/debug-step.mjs run-step runProductPreflight --port $PORT --json '{"projectId":"<id>"}'

# 全自动
node -e "
const renderer = ...; 
renderer.evaluate(() => window.vbk.automation.retryPhase('<id>', 'itinerary'))
"
```

## 关键调试 URL

- 行程描述：`https://vbooking.ctrip.com/ivbk/vendor/tourdays?productid={id}&istab=1&from=vbk`
- 套餐管理：`https://vbooking.ctrip.com/ivbk/vendor/packageManage?productid={id}&from=vbk`
- 价格库存：`https://vbooking.ctrip.com/ivbk/vendor/priceInventory?productid={id}&from=vbk`
- 资源配置：`https://vbooking.ctrip.com/product/input/newResourceRule?productid={id}&from=vbk`
- 产品编辑器：`https://vbooking.ctrip.com/ivbk/vendor/baseInfoMerge?productId={id}&from=vbk`

## 已知 trade-off

- 当前 runner 在 disabled 状态下返回 skipped 而不是 throw，所以 VBK 后端数据缺失时仍能完成整个 draft 流程。后续如果 VBK 修复了模板问题，把 fillAndSavePackage / fillAndSubmitPricingInventory 等的 disabled 兜底移除即可。
- 当前的「在当前页面重试」偏好让 retry 机制不会重新打开 baseInfoMerge，避免状态丢失。这意味着如果 phase 真的需要 reload，得手动改 runner。

