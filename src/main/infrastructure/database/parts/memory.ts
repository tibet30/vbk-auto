/**
 * 本地记忆存储 barrel：显式偏好（explicit）与推断偏好（inferred）。
 *
 * 约定：
 *   1) 所有写入都带 owner_user_id（不支持匿名 fallback）；
 *   2) 更新、禁用、删除都带 owner_user_id，避免跨用户误改；
 *   3) SQL 语义尽量集中在这里，避免上层重复拼表。
 *
 * 子模块分工：
 *   - types.ts     DB row 类型 + parseConditions + toUserMemory；
 *   - list.ts      读：listUserMemories / getUserMemory / getMemoryByTopic / getMemoryMaintenanceState；
 *   - state.ts     维护状态写：createMemoryState / bump* / createOrUpdate* / markMemorySuccess；
 *   - write.ts     记忆 CRUD 写：saveUserMemory / updateUserMemory / disableUserMemory / deleteUserMemory；
 *   - evidence.ts  证据写：addMemoryEvidence / listMemoryEvidence / markMemoryUsed。
 *
 * 调用方继续 `import {...} from "./memory.js"`，符号由下面这些行再聚合出去。
 */

export type { MemoryRow, MemoryEvidenceRow, MaintenanceRow } from "./memory/types.js";
export { parseConditions, toUserMemory } from "./memory/types.js";

export {
  listUserMemories,
  getUserMemory,
  getMemoryByTopic,
  getMemoryMaintenanceState,
} from "./memory/list.js";

export {
  createMemoryState,
  bumpMemoryMaintenanceCursor,
  clearMemoryMaintenancePending,
  createOrUpdateMemoryState,
  markMemorySuccess,
} from "./memory/state.js";

export {
  saveUserMemory,
  updateUserMemory,
  disableUserMemory,
  deleteUserMemory,
} from "./memory/write.js";

export {
  addMemoryEvidence,
  listMemoryEvidence,
  markMemoryUsed,
} from "./memory/evidence.js";

// 旧别名（保持源码中 `MemoryRecord` 类型对外可用）。
export type { MemoryRecord } from "./memory/types.js";