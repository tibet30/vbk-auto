# 2026-08-04 第四轮压缩总结 — 攻克套餐环节

## 当前状态

```
status: succeeded
  itinerary       : completed
  package         : completed (skipped: VBK 模板下拉为空)
  pricingInventory: completed (skipped: 套餐未保存)
  vehicleResource : completed (skipped: 入口 disabled)
  terms           : completed (skipped: tab disabled)
  preflight       : completed
```

整个 draft 流程能跑完，但 **fillAndSavePackage 真实保存** 这一步卡在 VBK 后端数据缺失。

## fillAndSavePackage 卡点

VBK 套餐表单必填字段里有 2 个下拉是空的：
- **出行人资料项包** (`#customer_info_package`) — 仅占位项
- **出行人信息模板** (`#customer_info_template`) — 仅占位项

当前账号 `vbk_671205` 没有预置「客户信息模板」。

`出行人信息` 是 radio（值 1 = 出行人信息模板 / 值 2 = 自定义资料项包），选哪一项都会卡在空模板上。

## 本轮目标

**真正打通 fillAndSavePackage**：让 VBK 套餐保存按钮可点击，套餐保存成功，下游 pricingInventory 能跑通真实填写。

## 攻克方向

1. **方案 A：在 VBK 后台预置客户信息模板**
   - 路径猜测：VBK 可能有「账号设置 → 客户信息模板」或「我的资源 → 模板」入口
   - 通过 playwright 自动化访问、添加模板
   - 风险：可能不在公开页面，需要登录后特定权限

2. **方案 B：调用 VBK API 直接预置**
   - 抓 network 请求，找添加模板的 API
   - 用 fetch 调用
   - 风险：需要 cookie / CSRF token / 正确的参数

3. **方案 C：通过其他产品借用模板**
   - 看成功产品 `76522690` 的 `customer_info_template` 实际值是什么
   - 如果有非空值，研究如何跨产品复用

4. **方案 D：bypass VBK 校验**
   - 直接调保存 API，跳过前端校验
   - 风险：需要完整理解 VBK 后端协议

## 关键文件位置

- `src/main/automation/ctrip.ts` — fillAndSavePackage 在 ~1966 行
- `scripts/debug-step.mjs` — debug 入口
- `/tmp/electron-port` — 当前 Electron CDP 端口

## 下一步

1. 在 VBK 后台找「客户信息模板」配置入口
2. 用 playwright 抓 network，分析模板添加 / 查询 API
3. 写自动化脚本，配置模板后再跑 fillAndSavePackage