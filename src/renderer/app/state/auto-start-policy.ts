/**
 * Auto-start 决策：纯函数版本，与 derived.ts 的 useEffect 解耦。
 *
 * 背景：原 auto-start effect 在 project.id 变更时立刻运行，但 planning.state(projectId)
 * 仍是异步查库中。空草稿 + persisted failed 的项目被重新打开时，effect 会看到
 * planningState=null，把失败的 project 又拉起一次规划。本函数把决策集中起来：
 *   - 必须等到 planning.state() 完成（planningStateLoadedProjectId === projectId）；
 *   - 完成后若仍为 undefined（全新项目）→ 允许一次 auto-start；
 *   - 完成后若为 failed/needs_user/running/completed → 永不 auto-start。
 *
 * 与 derived.ts 配合：derived.ts 在调用 planning.state().then 时，无论结果是
 * undefined 还是 state，都把 planningStateLoadedProjectId 设为当前 projectId；
 * 这样 effect 再跑时就不会再撞到 sentinel 不匹配。
 */

import type { PlanningGenerationState } from "../../../shared/contracts-planning.js";

export interface AutoStartInputs {
  /** 当前 project 是否存在（null 表示未打开任何项目）。 */
  hasProject: boolean;
  /** 当前 project.id；用于与 sentinel / autoStartUsed 比对。 */
  projectId: string;
  /** 是否存在用户消息（存在 → 不该自动生成）。 */
  hasUserMessages: boolean;
  /** itinerary 是否已有内容（非空数组 → 不该自动生成）。 */
  hasItinerary: boolean;
  /** 当前激活的 AI 提供商是否已配置 API Key。 */
  hasAiKey: boolean;
  /** planning.state(projectId) 是否已对当前 projectId 完成。null 表示从未加载过。 */
  planningStateLoadedProjectId: string | null;
  /** 已加载的 planning.state 结果；undefined / 新项目 → null。 */
  planningState: PlanningGenerationState | null;
  /** 当前会话内已 auto-start 过的 projectId；同一 project 只允许一次。 */
  autoStartUsed: string | null;
}

/**
 * 纯函数：返回当前是否应触发 planning.start。
 *
 * 关键不变量：sentinel mismatch（planningStateLoadedProjectId !== projectId）一律返回
 * false；这是修复 race 的核心，保证 effect 不会在 lookup 还没回来时把项目又拉起。
 */
export function shouldAutoStartPlanning(inputs: AutoStartInputs): boolean {
  if (!inputs.hasProject) return false;
  if (!inputs.hasAiKey) return false;
  if (inputs.hasUserMessages) return false;
  if (inputs.hasItinerary) return false;
  // 关键：必须等到 planning.state() 完成；null sentinel 或别的 projectId 都拒绝。
  if (inputs.planningStateLoadedProjectId !== inputs.projectId) return false;
  // 同 project 本会话内已经自动跑过一次，不再触发（避免规划.start 结果回来后又被重跑）。
  if (inputs.autoStartUsed === inputs.projectId) return false;
  // 任何已加载的 planningState（failed / needs_user / running / completed / pending）都不再自动起。
  if (inputs.planningState !== null) return false;
  return true;
}