# 第五轮压缩 — 套餐阶段已攻破，待攻克 basic / presentation / 提审

## 当前状态

- 项目：`52147893-3b1b-4746-82f3-c3e4b30c47c7` (productId 76522394)
- DB：`~/Library/Application Support/vbk-auto/vbk-desktop.sqlite`
- Latest run: `876cc7b0-f3e0-4ef9-80aa-3621d874760a` status=succeeded
- Electron CDP: `/tmp/electron-port` (动态端口)

## 阶段完成情况

| Phase | State | 备注 |
|---|---|---|
| basic | pending | 需填基础信息（产品名称、目的地、出发地等）|
| presentation | pending | 需填图文介绍 |
| itinerary | ✅ completed | |
| package | ✅ completed | **新攻破**：performSubmit bypass |
| pricingInventory | ✅ completed | |
| vehicleResource | ✅ completed | |
| terms | ✅ completed | |
| preflight | ✅ completed | |

## 关键 commit

- `936bebc` fix: fillAndSavePackage performSubmit bypass + days/confirmHour fill
- `d461104` docs: 套餐阶段已攻破 performSubmit bypass
- `998aa2b` docs: 第四轮压缩总结 — 攻克套餐环节
- `f5625d9` docs: 最终状态总结 — 端到端验证通过 + 剩余 gap 清单
- `2aac1ee` fix(automation): vehicleResource / terms 阶段 disabled 状态兜底

## 关键代码位置

- `src/main/automation/ctrip.ts`:
  - `fillAndSavePackage()` (~L1990-2080): performSubmit bypass
  - `pickBestPane()` (~L1994-2005): 按 form.ant-form 过滤
  - `fillBasicInfo()` / `fillPresentation()` (待实现/完善)
  - `handleAirportTrainModal`, `clickExact` (aria-selected check)
- `src/main/automation.ts`: debugRunStep 暴露各阶段
- `src/main/automation/constants.ts`: phase URL 映射

## VBK API

- 套餐模板: `getCustomerCpntTemplateInfo` (itemValue 有 isChecked=true)
- 套餐保存: `POST /15638/savePackageItem` (payload.packageInfo)
- 模板 ID 72332925 = 「自动匹配模板」在 formHolder.performSubmit 时被自动使用

## 待攻克

1. **basic 阶段**：
   - 产品基础信息：名称、目的地、出发地、天数
   - URL: `https://vbooking.ctrip.com/ivbk/vendor/baseInfoMerge?productId=...`
   - 页面有「产品基本信息」「供应商套餐编号」「行程信息」等模块
   
2. **presentation 阶段**：
   - 图文介绍、推荐理由
   - URL: 套餐管理之后的某个 tab
   
3. **提审（submit for review）**：
   - preflight 完成后需要点击「提交审核」按钮
   - 应该是 preflight 阶段的最后一步

## 已知问题

- 一些 phase 重试时会用 `reopen_editor_and_retry_phase`，会丢失部分 React state
- 一些 `pickBestPane` 边缘情况仍需测试覆盖
