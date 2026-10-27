import type { AutomationRun } from "../../../shared/contracts.js";
import { domesticShortPoiRiskName } from "../../../shared/domestic-short-poi-risk.js";

/** 产品壳与销售控制不依赖行程景点，剔除 POI 后保持已完成。 */
const SHELL_PHASES = new Set(["saleControl"]);

/** 本地已剔除但远端录入仍停在该 POI 的数据风险上（历史产品只删了本地）。 */
export function automationBlockedByPoiRisk(run: AutomationRun | undefined, poiName: string): boolean {
  if (run?.status !== "failed") return false;
  return Object.values(run.recovery?.phases ?? {}).some((phase) =>
    phase.state === "needs_user" && domesticShortPoiRiskName(phase.finalError ?? "") === poiName);
}

/**
 * 剔除平台拒绝的 POI 后，基本信息（主标题、国家景区）、产品图文和行程都可能
 * 仍引用该 POI。从基本信息起重新录入并回读，而不是只重试失败的行程阶段。
 * 返回 undefined 表示没有可重开的远端录入（尚未创建产品壳）。
 */
export function reopenAutomationAfterPoiRemoval(
  run: AutomationRun | undefined,
  poiName: string,
  at = new Date().toISOString(),
): AutomationRun | undefined {
  if (!run || !run.phases.some((item) => item.phase === "basic")) return undefined;
  const reopened = run.phases.filter((item) => !SHELL_PHASES.has(item.phase)).map((item) => item.phase);
  const recovery = run.recovery
    ? { phases: Object.fromEntries(Object.entries(run.recovery.phases).filter(([phase]) => !reopened.includes(phase))) }
    : undefined;
  return {
    ...run,
    status: "failed",
    currentPhase: "basic",
    phases: run.phases.map((item) => SHELL_PHASES.has(item.phase)
      ? { ...item }
      // 失败标记让断点重试从 basic 开始；其余阶段在本次录入中依次重做。
      : { phase: item.phase, status: item.phase === "basic" ? "failed" as const : "pending" as const }),
    ...(recovery ? { recovery } : {}),
    logs: [...run.logs, { at, level: "warning",
      message: `已剔除「${poiName}」；基本信息、产品图文与行程等栏目将从基本信息起重新录入并回读。` }],
    screenshot: undefined,
  };
}
