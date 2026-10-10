/**
 * 产品 JSON 文档化存储位置（barrel 常量）：
 *   - 表：products.product_json（TEXT，UTF-8 JSON 字符串）
 *   - 文件：dataPath（app.getPath("userData")）/vbk-desktop.sqlite
 *   - 写入时机：
 *     1. createProduct：插入初始 product（仅骨架 + 空 presentation/itinerary）
 *     2. 规划 AI 输出 → stage-runner.executeStageOutput → runtime.writeModule
 *        → applyProductPatchSafe → db.updateProduct
 *     3. 运营手动复核（基础信息/管家/价格/封面）→ applyManualReviewField
 *        → db.updateProduct
 *     4. 自动化阶段回填（hotelResource.resourceId/Name）→ fillAndSaveXxx
 *        → db.updateProduct
 *   - 读取时机：
 *     - IPC products.get → db.getProduct → parseAndNormalizeProductJson
 *     - 规划 deep validation → runtime.loadCurrentProduct
 *     - automationBlockers → evaluateAutomationContract
 *     - 自动化 fillAndSave* 校验 → assertPresentationReadyForVbk 等
 */

export const PRODUCT_JSON_LOCATION = {
  table: "products",
  column: "product_json",
  format: "JSON 字符串（TEXT，UTF-8）",
  schema: "src/main/automation/schema/schema-definitions.ts#productSchema",
  persistence: "better-sqlite3 → dataPath/vbk-desktop.sqlite",
  dataPath: "app.getPath('userData')/vbk-desktop.sqlite",
} as const;