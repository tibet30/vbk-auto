/**
 * Recent-project 恢复策略：纯函数版本。
 *
 * 背景：原 recovery effect 只看 activeProjectId + project?.id 两条依赖，
 * 没限制当前 view。当用户在项目详情页点击"工作台"按钮
 * （setProject(null) + setView("workspace")）或"项目"/"设置"/"操作日志"按钮
 * （setProject(null) + setView(other)）时，effect 会因为 project?.id 变化而
 * 重跑；在 in-flight 窗口里，刚被用户清掉的项目会被重新塞回详情页。
 *
 * 本模块把决策集中起来：
 *   - 必须 view === "workspace"，切到其它视图（projects/settings/operation-log）
 *     一律不放行；
 *   - 必须 activeProjectId 非空、project 仍为空（用户没在初始化期间手动开项目）；
 *   - 同一会话内只尝试一次（hasAttempted gate）：点击"工作台"后 view 仍是
 *     workspace，如果只看 view 会再次触发，把刚被清掉的项目又塞回来；
 *   - 用户主动打开项目（在初始化窗口内手动 openProject）也会"消费"本会话的
 *     恢复机会——手动开项目意味着用户已经接管了项目选择，session 内不应再
 *     由 effect 自动恢复（否则用户清掉 project 后回到 workspace 又被拉回详情）。
 *     这条规则同时兼容"项目不存在 / 已被删除"的失败路径；
 *   - preload API 不可用时（preload 尚未注入）不发起请求。
 *
 * 与 derived.ts 配合：derived.ts 用一个 useRef 跟踪 hasAttempted，effect 体里
 * 调用 simulateRecoveryEffectTick 完成单次决策 + ref 推进。decision-only，
 * 无副作用，便于纯函数单测。
 */

/** 与 base.ts 的 View 字符串联合保持一致。 */
export type RecoveryView = "workspace" | "projects" | "settings" | "operation-log";

export interface RecoveryInputs {
  /** preload API 是否已注入（window.vbk 已存在）。 */
  hasApi: boolean;
  /** 当前 view 标签。 */
  view: RecoveryView;
  /** 当前 project 是否为 null（用户已主动退出详情或从未打开）。 */
  hasProject: boolean;
  /** 当前 activeProjectId 是否非空（localStorage 有残留 id）。 */
  hasActiveProjectId: boolean;
  /**
   * 当前会话内是否已对 activeProjectId 发起过恢复（成功 / 失败 / in-flight 都算）。
   * 用 ref 实现；新会话（refresh / 重启）自然重置为 false。
   */
  hasAttempted: boolean;
}

export interface RecoveryDecision {
  /** 本次 effect tick 是否应发起 projects.get(activeProjectId)。 */
  shouldRequest: boolean;
  /** effect tick 完成后 recoveryAttemptedRef 应被置的值。 */
  nextHasAttempted: boolean;
}

/**
 * 纯函数：返回当前是否应发起最近项目的恢复请求。
 *
 * 调用方契约：
 *   - true → 可以发起 api().projects.get(activeProjectId)，并把 hasAttempted 置 true；
 *   - false → 直接 return，不发起请求；
 *   - in-flight 完成时 .then() / .catch() 还要再用最新 view + activeProjectId 校验
 *     一次（policy 函数不感知异步取消，详见 derived.ts 的 currentViewForRecoveryRef）。
 */
export function shouldAttemptRecentProjectRecovery(inputs: RecoveryInputs): boolean {
  if (!inputs.hasApi) return false;
  if (!inputs.hasActiveProjectId) return false;
  if (inputs.hasProject) return false;
  if (inputs.view !== "workspace") return false;
  if (inputs.hasAttempted) return false;
  return true;
}

/**
 * 纯函数：模拟 derived.ts 中 recovery effect 每次 tick 的完整行为——
 * 决策"是否发起请求"以及"下一步 hasAttempted ref 应该被推进为什么"。
 *
 * 与 shouldAttemptRecentProjectRecovery 的差别：本函数把"消费本会话恢复机会"
 * 的所有路径都收口到一起，避免 derived.ts effect 在多个短路分支里各自
 * 维护 ref 推进逻辑时漏掉关键场景。
 *
 * 消费机会的触发条件（任一满足即消费）：
 *   1. policy 放行（即将发起请求）；
 *   2. project 已存在 + view === "workspace" + activeProjectId 非空——
 *      即用户在初始化期间手动打开了项目，主动接管了项目选择。
 *      这种情况下 effect 不应再恢复，但必须把 hasAttempted 翻为 true，
 *      否则用户随后 setProject(null) + setView("workspace") 时 effect 会再次放行，
 *      把刚被清掉的项目又塞回去（核心防回填）。
 *
 * 不消费机会（透传 inputs.hasAttempted）：
 *   - view !== "workspace"（用户在 projects / settings / operation-log 视图）；
 *   - api 不可用 / activeProjectId 为空；
 *   - 用户已经在更早的时刻消费过机会（hasAttempted=true 仍为 true 时透传）。
 *
 * 调用方契约：derived.ts 的 effect 体里直接
 *   const decision = simulateRecoveryEffectTick({...});
 *   recoveryAttemptedRef.current = decision.nextHasAttempted;
 *   if (!decision.shouldRequest) return;
 *   // ...发起 projects.get...
 */
export function simulateRecoveryEffectTick(inputs: RecoveryInputs): RecoveryDecision {
  if (shouldAttemptRecentProjectRecovery(inputs)) {
    return { shouldRequest: true, nextHasAttempted: true };
  }
  // 手动开项目场景：用户在初始化窗口内主动 openProject，session 内不应再恢复。
  // 条件与"本次 effect tick 在 workspace 内 + project 已存在 + localStorage 还有残留 id"
  // 三个条件同时成立 → 消费本会话恢复机会。
  const manuallyOpened =
    inputs.hasApi
    && inputs.view === "workspace"
    && inputs.hasProject
    && inputs.hasActiveProjectId;
  if (manuallyOpened) {
    return { shouldRequest: false, nextHasAttempted: true };
  }
  return { shouldRequest: false, nextHasAttempted: inputs.hasAttempted };
}
