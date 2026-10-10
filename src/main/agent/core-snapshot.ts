/**
 * AgentSnapshotManager + 公共 helper + 类型：re-export 入口。
 *
 * 拆分子文件：
 *   - types.ts   : TurnToken / AgentStreamState / NoProgressBlocker；
 *   - helpers.ts : isMaterialWriteResult / materialWriteResults /
 *                  hasSyntheticNoopApproval（公开 classify 助手）；
 *   - blockers.ts: collectNoProgressBlockers / noProgressPauseMessage
 *                  （主类 pauseAfterRepeatedBlocker 内部委托）；
 *   - manager.ts : AgentSnapshotManager class 本体（状态机 + 交互 +
 *                  流式 + blocker 集成）。
 *
 * 公开 API 路径（其它文件 import 时只需 `from "./core-snapshot.js"`）：
 *   - AgentSnapshotManager
 *   - materialWriteResults, hasSyntheticNoopApproval
 *   - TurnToken, AgentStreamState, NoProgressBlocker
 */

export {
  AgentSnapshotManager,
} from "./core-snapshot/manager.js";
export {
  isMaterialWriteResult,
  materialWriteResults,
  hasSyntheticNoopApproval,
} from "./core-snapshot/helpers.js";
export {
  collectNoProgressBlockers,
  noProgressPauseMessage,
} from "./core-snapshot/blockers.js";
export type {
  TurnToken,
  AgentStreamState,
  NoProgressBlocker,
} from "./core-snapshot/types.js";