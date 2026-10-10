/**
 * 「产品特色」React 状态窄同步 helper（barrel）。
 *
 * 历史 importer 继续：
 *   import {
 *     findReactOnChangeInFiber,
 *     listReactKeys,
 *     syncReactOnChange,
 *     syncReactStateForTarget,
 *     isFiberObject, normalize, pickFiberKey, pickFirstFiberAnchor, readFiberKeys,
 *   } from "./features.react-sync.js";
 *
 * 子模块：
 *   - types.ts                   ReactSyncOutcome + 同步轮询常量；
 *   - fiber-onchange.ts          纯 JS API（listReactKeys + findReactOnChangeInFiber）；
 *   - sync.ts                    page.evaluate 编排（syncReactOnChange + syncReactStateForTarget）。
 */

export type { ReactSyncOutcome } from "./features.react-sync/types.js";
export {
  REACT_SYNC_POLL_MS,
  MAX_FIBER_DEPTH,
} from "./features.react-sync/types.js";
export {
  findReactOnChangeInFiber,
  listReactKeys,
} from "./features.react-sync/fiber-onchange.js";
export {
  syncReactOnChange,
  syncReactStateForTarget,
} from "./features.react-sync/sync.js";

// 重导出纯 helper（便于测试切片识别与外部直接使用）
export {
  isFiberObject,
  normalize,
  pickFiberKey,
  pickFirstFiberAnchor,
  readFiberKeys,
} from "./features.react-helpers.js";