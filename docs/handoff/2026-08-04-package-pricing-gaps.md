# 2026-08-04 套餐 & 价格库存阶段现状

## fillAndSavePackage

**现状**：
- ✅ runner 能定位 active tabpanel（多个 NewPackage 表单 ID 重复，已通过 `pickBestPane` 选出含最多 NewPackage 控件的 pane 解决）。
- ✅ runner 能填以下字段：
  - 供应商套餐编号 `NewPackage_vendorResourceCode`
  - 套餐介绍 `NewPackage_description`
  - 7 个 radio（isHotelResource=T, priceInputType=1, isHotelShareRoom=F, isContainBedFee=F, needShuttle=F, isSmsVBKNotice=T）
  - 确认方式 `NewPackage_vendorConfirmModeId`（Vbooking人工确认）
- ⚠️ 「保存」按钮仍然 disabled，原因是 `出行人资料项包` (`customer_info_package`) 和 `出行人信息模板` (`customer_info_template`) 两个下拉项为空（仅占位项）。

**根因**：
- VBK 后台要求供应商预先配置「客户信息模板」，没有模板时下拉框就是空的。
- 当前账号 `vbk_671205` 没有配置模板，所以无法填这两项。
- 出行人信息（`radio:1` = 出行人信息模板 / `radio:2` = 自定义资料项包）选哪一项都会卡在空模板上。

**当前 runner 行为**：
- 检测到「保存」按钮 disabled 时返回：
  ```
  {
    "skipped": "保存按钮未启用（出行人资料项 / 模板下拉为空，需要供应商后台预置模板）",
    "packageName": "大同2天1晚私家团·家庭专属",
    "saveDisabled": true
  }
  ```

**手动解决路径**：
1. 登录携程 VBK 后台，进入「设置 → 客户信息模板」
2. 添加至少 1 个模板（如「标准出行人信息模板」）
3. 重新跑 fillAndSavePackage，runner 会自动选第一个可用项

## fillAndSubmitPricingInventory

**前置依赖**：必须先 fillAndSavePackage 成功，否则 `设置价格/库存` 按钮在 footer 区是 disabled 状态。

**已修复**：
- ✅ 现在会先关闭「我知道了」提示 modal（产品未填写库存数据时 VBK 弹出）。
- 走 `套餐价格库存` tab → `设置价格/库存` 按钮 → dialog 出现

**测试结果**（用 productId=76522394 即当前产品）：
- ❌ `设置价格/库存` 按钮 disabled，dialog 不会出现
- 用 productId=76522690（有 package）才能正常打开 dialog

## 下一步
- Gap A：让供应商去 VBK 后台预先配置客户信息模板
- Gap B：fillAndSubmitPricingInventory 修复后可在 package 完成后跑通
- Gap C：hotelResource / vehicleResource 等依赖 package 完成后才可测

