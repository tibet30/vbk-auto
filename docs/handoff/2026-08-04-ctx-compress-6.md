# 第六轮压缩 — basic 阶段诊断

## 进度

1. **fillBasicInfo 已暴露给 debug runner**: 改了 `src/main/automation.ts` 加 `stepName === "fillBasicInfo" || stepName === "fillPresentation"` 分支，调用 `fillBasicInfo / fillAndSavePresentation`
2. **accountInfo 已添加到 product_json**: `{"accountName":"管理","servicePhone":"0609240","butlerContactCardId":1368298,"butlerContactName":"安思科","providerId":1279416}`
3. **fillBasicInfo 实际成功填表**: baseInfo.subName / providerProductName / vendorProductCode / phone400 / serviceLanguages / operationNote / scenicArea (山西) 全部 filled
4. **但 DB phases[].status 仍是 pending**: 因为 runner 只重试 failed 阶段，不重试 pending

## 关键代码路径

- `src/main/automation.ts:253` — `startIndex = retryFrom ? draftPhases.indexOf(retryFrom) : 0`
- `src/main/automation.ts:399` — `if (startIndex === 0)` 才跑 basic
- `src/main/automation.ts:420` — `const startFrom = Math.max(1, startIndex)` 后续阶段从 startFrom 起跳
- 所以第一次跑时（startIndex=0）应该跑 basic，但 DB 显示 basic 一直 pending

## 诊断

最近 3 次 run 状态：
- 876cc7b0 succeeded (basic pending, presentation pending, 其它 completed)  
- 6f20e422 failed itinerary (basic pending)
- 7fd85a13 failed itinerary (basic pending)

所有历史 run 都是 basic pending。说明首次 retry 是从 itinerary 阶段开始的（不是从 basic），所以 basic 从来没被真跑过。

## 提审下一步

填完 basic/presentation 后，需要：
- preflight 阶段的最后一步是「提交审核」
- 应该是 `runProductPreflight` 里有这一步
- 之前的 preflight completed 但可能没真的提审

## Commit history

- `936bebc` fix: fillAndSavePackage performSubmit bypass
- `d461104` docs: 套餐阶段已攻破
- `be86176` docs: 第五轮压缩
- `d461104` 已 push
- 当前: debug-runner 加 fillBasicInfo/fillPresentation 支持

## 文件路径

- src/main/automation.ts (debugRunStep 在第 50-127 行)
- src/main/automation/ctrip.ts:2597 fillBasicInfo, :1008 fillAndSaveBasicInfo, :1382 fillAndSavePresentation
- src/main/automation/workflow.ts:6 PHASES
- src/main/automation/schema.ts:263 shouldRefillBasicInfo
