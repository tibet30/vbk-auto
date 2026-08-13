/**
 * Auto-start 决策：纯函数版本，与 derived.ts 的 useEffect 解耦。
 *
 * 背景：原 auto-start effect 在 product.id 变更时立刻运行，但 planning.state(localProductId)
 * 仍是异步查库中。空草稿 + persisted failed 的产品被重新打开时，effect 会看到
 * planningState=null，把失败的 product 又拉起一次规划。本函数把决策集中起来：
 *   - 必须等到 planning.state() 完成（planningStateLoadedLocalProductId === localProductId）；
 *   - 完成后若仍为 undefined（全新产品）→ 允许一次 auto-start；
 *   - 完成后若为 failed/needs_user/running/completed → 永不 auto-start。
 *
 * 与 derived.ts 配合：derived.ts 在调用 planning.state().then 时，无论结果是
 * undefined 还是 state，都把 planningStateLoadedLocalProductId 设为当前 localProductId；
 * 这样 effect 再跑时就不会再撞到 sentinel 不匹配。
 */

import type { PlanningGenerationState } from "../../../shared/contracts-planning.js";

export interface AutoStartInputs {
  /** 当前 product 是否存在（null 表示未打开任何产品）。 */
  hasProduct: boolean;
  /** 当前 product.id；用于与 sentinel / autoStartUsed 比对。 */
  localProductId: string;
  /** 是否存在用户消息（存在 → 不该自动生成）。 */
  hasUserMessages: boolean;
  /** itinerary 是否已有内容（非空数组 → 不该自动生成）。 */
  hasItinerary: boolean;
  /** 当前激活的 AI 提供商是否已配置 API Key。 */
  hasAiKey: boolean;
  /** planning.state(localProductId) 是否已对当前 localProductId 完成。null 表示从未加载过。 */
  planningStateLoadedLocalProductId: string | null;
  /** 已加载的 planning.state 结果；undefined / 新产品 → null。 */
  planningState: PlanningGenerationState | null;
  /** 当前会话内已 auto-start 过的 localProductId；同一 product 只允许一次。 */
  autoStartUsed: string | null;
}

/**
 * 纯函数：返回当前是否应触发 planning.start。
 *
 * 关键不变量：sentinel mismatch（planningStateLoadedLocalProductId !== localProductId）一律返回
 * false；这是修复 race 的核心，保证 effect 不会在 lookup 还没回来时把产品又拉起。
 */
export function shouldAutoStartPlanning(inputs: AutoStartInputs): boolean {
  if (!inputs.hasProduct) return false;
  if (!inputs.hasAiKey) return false;
  if (inputs.hasUserMessages) return false;
  if (inputs.hasItinerary) return false;
  // 关键：必须等到 planning.state() 完成；null sentinel 或别的 localProductId 都拒绝。
  if (inputs.planningStateLoadedLocalProductId !== inputs.localProductId) return false;
  // 同 product 本会话内已经自动跑过一次，不再触发（避免规划.start 结果回来后又被重跑）。
  if (inputs.autoStartUsed === inputs.localProductId) return false;
  // 任何已加载的 planningState（failed / needs_user / running / completed / pending）都不再自动起。
  if (inputs.planningState !== null) return false;
  return true;
}