/**
 * 产品 CRUD + 会话消息 + research + automation 写入（barrel）：
 *   - listProducts / createProduct / getProduct / deleteProduct
 *   - updateProduct / updateBasicInfoField / setProductId / setBasicInfoSaved
 *   - setProductLifecycle / writeAutomationWithProductStatus（事务化多表写入）
 *   - addMessage / updateMessageStatus / recoverUnansweredMessages
 *   - saveAutomation / recoverOrphanAutomationRuns
 *
 * 全部接受 Database.Database 句柄，便于在拆分模块上复用同一个连接。
 *
 * 子文件分工：
 *   - import.ts：createProduct / importProductSnapshot / getProduct / deleteProduct；
 *   - messages.ts：addMessage / updateMessageStatus / recoverUnansweredMessages / touchProduct；
 *   - automation.ts：saveAutomation / writeAutomationWithProductStatus / recoverOrphanAutomationRuns；
 *   - basic-info.ts：updateBasicInfoField / setProductId / setBasicInfoSaved / setProductLifecycle；
 *   - product-update.ts：updateProduct（独立模块，方便未来加补丁迁移）。
 *   - product-list.ts：listProducts / listProductsPaginated（独立模块，含分页逻辑）。
 *
 * 调用方零改动：所有 export 仍从 ./products.js 引用。
 */

export { updateProduct } from "./product-update.js";
export { listProducts, listProductsPaginated, type ProductListPage } from "./product-list.js";

export { createProduct, importProductSnapshot, getProduct, deleteProduct } from "./products/import.js";
export { addMessage, recoverUnansweredMessages, touchProduct, updateMessageStatus } from "./products/messages.js";
export { recoverOrphanAutomationRuns, saveAutomation, writeAutomationWithProductStatus } from "./products/automation.js";
export { setBasicInfoSaved, setProductId, setProductLifecycle, updateBasicInfoField } from "./products/basic-info.js";