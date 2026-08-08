import type { CreateProjectInput, FieldState, OperationStatus, ProjectDetail, ProjectReadiness, ProjectSummary } from "../../../shared/contracts.js";

export type Stage = "review" | "vbk";
export type View = "workspace" | "projects" | "settings" | "operation-log";

export const api = () => window.vbk;

// 操作日志页面的状态过滤选项。只列出实际出现的状态，避免全部都暴露给 UI。
export const OPERATION_STATUS_OPTIONS: Array<{ value: OperationStatus | "all"; label: string }> = [
  { value: "all", label: "全部状态" },
  { value: "failed", label: "失败" },
  { value: "succeeded", label: "成功" },
  { value: "skipped", label: "跳过" },
  { value: "running", label: "进行中" },
];
export const emptyReadiness: ProjectReadiness = { ready: false, completion: 0, issues: [] };
export const initialInput: CreateProjectInput = { destination: "", days: 2, productForm: "privateTour" };

// 切换项目时为新项目选择一个合理的初始阶段；用户可以随后自由切换。
export function initialStageFor(status: ProjectSummary["status"] | undefined): Stage {
  if (status === "automating" || status === "draft_saved") return "vbk";
  return "review";
}

export function statusLabel(status?: string) { return ({ planning: "方案规划中", review: "等待确认", automating: "正在录入", draft_saved: "草稿已保存", blocked: "需要处理" } as Record<string, string>)[status || ""] || "准备开始"; }
export function statusState(status?: ProjectSummary["status"]) { return ({ planning: "researching", review: "needsConfirmation", automating: "researching", draft_saved: "confirmed", blocked: "blocked" } as Record<ProjectSummary["status"], string>)[status || "planning"]; }
// 字段状态 → 中文短标签。设计规范要求界面文案默认中文，只在内部数据层保留英文枚举。
export function fieldStateLabel(state: FieldState | undefined): string {
  return ({
    proposed: "AI 已建议",
    researching: "正在核查",
    resolved: "待你确认",
    needs_confirmation: "需要补充",
    confirmed: "已确认",
    blocked: "卡住待处理",
  } as Record<FieldState, string>)[(state || "proposed") as FieldState];
}
export function formatUpdatedAt(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未知";
  return date.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
export function valueOf(source: Record<string, unknown>, key: string) { const value = source[key]; return typeof value === "string" || typeof value === "number" ? String(value) : "待生成"; }
// 去除行程标题里重复出现的 DayN / 第N天 前缀，保留更具语义的副标题。
export function stripDayPrefix(title: string, index: number): string {
  const trimmed = title.trim();
  const patterns = [
    new RegExp(`^第\\s*${index + 1}\\s*天[:：、\\s-]*`),
    new RegExp(`^Day\\s*${index + 1}\\s*[:：、\\s-]*`, "i"),
    new RegExp(`^D${index + 1}\\s*[:：、\\s-]*`, "i"),
  ];
  let result = trimmed;
  for (const pattern of patterns) {
    if (pattern.test(result)) {
      result = result.replace(pattern, "");
      break;
    }
  }
  return result.trim() || trimmed;
}
export function activityKindLabel(kind: string): string {
  return ({ transport: "交通", visit: "游览", meal: "用餐", hotel: "入住", free: "自由活动", other: "安排" } as Record<string, string>)[kind] || "安排";
}

/** 复制纯文本到剪贴板。Electron 渲染进程里 navigator.clipboard 通常可用；
 * 保留 textarea fallback，避免某些环境 clipboard 不可用时按钮毫无反应。 */
export async function copyText(value: string): Promise<boolean> {
  if (!value) return false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // 忽略并走 fallback。
  }
  try {
    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}
export function isVehicleResourceTask(task?: ProjectDetail["researchTasks"][number]) {
  if (!task) return false;
  return /用车|车辆|车费|资源组|vehicle/i.test(`${task.label} ${task.detail || ""}`);
}
// 项目状态 → 用作第二步"草稿保存"现状文案，避免重复占用 statusLabel 的中文。
export function vbkStageStatusText(project: ProjectDetail | null): { tone: "waiting" | "running" | "saved" | "ready" | "blocked"; label: string; detail: string } {
  if (!project) return { tone: "waiting", label: "等待选择项目", detail: "开始一个产品项目后即可进入" };
  const blocked = recoveryNeedsUser(project.automation);
  if (blocked) return { tone: "blocked", label: "已停止，等待处理", detail: "请先在右侧按 AI 给出的指令完成手动操作，再重新发起一次保存草稿" };
  if (project.automation?.status === "running") return { tone: "running", label: "正在录入 VBK", detail: "浏览器自动化进行中，可在右侧观察执行进度" };
  if (project.automation?.status === "succeeded" || project.status === "draft_saved") return { tone: "saved", label: "草稿已保存到 VBK", detail: "提交审核与发布仍需在 VBK 手工完成" };
  return { tone: "waiting", label: "尚未录入 VBK", detail: "第一步审查通过后即可在右侧开始保存草稿" };
}

export type RecoveryStageLabel = { phase: string; display: string };

export const RECOVERY_PHASE_LABELS: Record<string, string> = {
  basic: "基础信息",
  product: "产品正文",
  itinerary: "每日行程",
  presentation: "产品卖点",
  commercial: "套餐与价格",
  vehicle: "用车资源",
  hotel: "酒店资源",
  cost: "费用项",
};

export const DEFAULT_RECOVERY_PHASE_LABEL = (phase: string) => phase || "当前阶段";

export function recoveryPhaseDisplay(phase: string): string {
  return RECOVERY_PHASE_LABELS[phase] || DEFAULT_RECOVERY_PHASE_LABEL(phase);
}

// 「重新执行」按钮需要中文文案。阶段名是带前缀的（hotelResource / vehicleResource），
// 「资源」二词足以区分；其他阶段直接用「套餐」、「班期」等业内词。这里专门
// 区分资源组两个阶段是因为它们在「资源配置」section 里并排出现。
export const RETRY_PHASE_LABELS: Record<string, string> = {
  basic: "基础信息",
  presentation: "产品图文",
  itinerary: "行程描述",
  package: "套餐",
  pricingInventory: "班期与价格",
  hotelResource: "酒店资源",
  vehicleResource: "用车资源",
  terms: "条款",
  preflight: "上架预检",
};

export function phaseDisplayLabel(phase: string): string {
  return RETRY_PHASE_LABELS[phase] || phase || "当前阶段";
}

// 自动录入阶段的展示文案 + VBK 入口 URL。
// VBK 产品录入页面的实际导航顺序。顺序与 VBK 后台页签一致：
//   销售控制 → 产品信息 → 产品图文 → 行程描述 → 套餐管理 →
//   价格库存班期 → 资源配置 → 条款维护
// 「销售控制」是新建产品 shell 的入口页（saleControlMerge），位于基本
// 信息之前；它不是自动化阶段，不映射到任何 phase。「资源配置」同时承载
// hotelResource / vehicleResource 两个阶段（同 newResourceRule 页面，
// 点不同入口切酒店/用车）；preflight 是最终一致性校验，对应不到独立
// VBK 页面，所以从这张导航表中省略。状态由 section.phaseNames 所列
// 阶段聚合给出；每个可重跑阶段在同一 section 内提供独立操作。
export interface VbkNavSection {
  key: string;
  label: string;
  /** 构造页面 URL；销售控制在尚无 productId 时回退到新增产品入口。 */
  buildUrl: (productId: string | undefined) => string | null;
  /** 映射到本页面的自动化阶段名；空数组表示该页面不直接对应阶段。 */
  phaseNames: string[];
}

export const VBK_HOST = "https://vbooking.ctrip.com";

// URL 栏只显示 pathname + 关键查询参数，完整 URL 太长会被省略号隐藏。
// productId/query 是「进入」跳转是否生效的关键判断依据，必须留下；
// 其余参数（from=vbk 之类）用 … 占位，避免地址栏变一长串。
export function formatBrowserPath(raw: string): string {
  try {
    const url = new URL(raw);
    const path = url.pathname || "/";
    const productId = url.searchParams.get("productId") ?? url.searchParams.get("productid");
    const producttype = url.searchParams.get("producttype");
    const parts: string[] = [path];
    if (productId) parts.push(`productId=${productId}`);
    if (producttype) parts.push(`producttype=${producttype}`);
    const compact = parts.join("?");
    const others = [...url.searchParams.entries()].filter(([k]) => k !== "productId" && k !== "productid" && k !== "producttype");
    return others.length > 0 ? `${compact}…` : compact;
  } catch {
    return raw || "/";
  }
}

export const VBK_NAV_SECTIONS: VbkNavSection[] = [
  {
    key: "saleControl",
    label: "销售控制",
    // 已生成 productId 时必须打开当前产品的销售控制；静态 producttype=0
    // 地址是“新增产品”入口，只能在产品壳尚未创建时使用。
    buildUrl: (id) => id
      ? `${VBK_HOST}/ivbk/vendor/saleControlMerge?from=vbk&productId=${encodeURIComponent(id)}`
      : `${VBK_HOST}/ivbk/vendor/saleControlMerge?producttype=0&from=vbk`,
    phaseNames: [],
  },
  {
    key: "basic",
    label: "产品信息",
    buildUrl: (id) => id ? `${VBK_HOST}/ivbk/vendor/baseInfoMerge?productId=${encodeURIComponent(id)}&from=vbk` : null,
    phaseNames: ["basic"],
  },
  {
    key: "presentation",
    label: "产品图文",
    // VBK 当前产品菜单返回的独立 productImageText 路由；baseInfoMerge
    // 的默认落点始终是“产品信息”。
    buildUrl: (id) => id ? `${VBK_HOST}/product/input/productImageText?productId=${encodeURIComponent(id)}&pattern=4&from=vbk` : null,
    phaseNames: ["presentation"],
  },
  {
    key: "itinerary",
    label: "行程描述",
    buildUrl: (id) => id ? `${VBK_HOST}/ivbk/vendor/tourdays?productid=${encodeURIComponent(id)}&istab=1&from=vbk` : null,
    phaseNames: ["itinerary"],
  },
  {
    key: "package",
    label: "套餐管理",
    buildUrl: (id) => id ? `${VBK_HOST}/ivbk/vendor/packageManage?productid=${encodeURIComponent(id)}&from=vbk` : null,
    phaseNames: ["package"],
  },
  {
    key: "pricingInventory",
    label: "价格库存班期",
    buildUrl: (id) => id ? `${VBK_HOST}/ivbk/vendor/priceInventory?productId=${encodeURIComponent(id)}&from=vbk` : null,
    phaseNames: ["pricingInventory"],
  },
  {
    key: "resource",
    label: "资源配置",
    buildUrl: (id) => id ? `${VBK_HOST}/product/input/newResourceRule?productid=${encodeURIComponent(id)}&from=vbk` : null,
    phaseNames: ["hotelResource", "vehicleResource"],
  },
  {
    key: "terms",
    label: "条款维护",
    buildUrl: (id) => id ? `${VBK_HOST}/ivbk/vendor/newResourceClause?productid=${encodeURIComponent(id)}&from=vbk` : null,
    phaseNames: ["terms"],
  },
];

// 操作日志的 stage 名 → VBK_NAV_SECTIONS 的 key。
// 自动化日志记录阶段时使用带 Info 后缀的命名（basicInfo），而导航 section
// key 是 basic；统一在这里归一，让「详情」按钮能把 VBK 浏览器导航到对应页面。
export const OPERATION_STAGE_TO_SECTION: Record<string, string> = {
  basicInfo: "basic",
  basic: "basic",
  saleControl: "saleControl",
  presentation: "presentation",
  itinerary: "itinerary",
  package: "package",
  pricingInventory: "pricingInventory",
  priceInventory: "pricingInventory",
  hotelResource: "resource",
  vehicleResource: "resource",
  terms: "terms",
};

/** 把日志条目的 stage 映射到可导航的 VBK section；无法映射时返回 undefined。 */
export function operationStageToSection(stage: string | undefined): VbkNavSection | undefined {
  if (!stage) return undefined;
  const key = OPERATION_STAGE_TO_SECTION[stage];
  if (!key) return undefined;
  return VBK_NAV_SECTIONS.find((section) => section.key === key);
}

export type AutomationPhaseRow = { phase: string; status: "pending" | "running" | "completed" | "failed" };
// 使用 PhaseRecovery 的结构性子集，避免依赖完整类型；state 允许是任意
// RecoveryState（含 running/advising/retrying/needs_user/completed）。
export type AutomationRecoveryMap = Record<string, { phase: string; state: string }>;

// 聚合一个 section 内所有映射阶段的整体状态：
//   1. 任何阶段 needs_user / failed → failed
//   2. 任何阶段 advising / retrying / running → running
//   3. 所有存在阶段均 completed → done
//   4. 否则 pending
// phaseNames 为空的 section（销售控制）不返回有效状态，前端不打 stageState。
export function aggregateSectionState(
  section: VbkNavSection,
  phases: AutomationPhaseRow[],
  recovery?: AutomationRecoveryMap,
): "pending" | "running" | "done" | "failed" | "idle" {
  if (section.phaseNames.length === 0) return "idle";
  const mapped = section.phaseNames
    .map((name) => phases.find((phase) => phase.phase === name))
    .filter((phase): phase is AutomationPhaseRow => Boolean(phase));
  if (mapped.length === 0) return "idle";
  const blocked = recovery && Object.values(recovery).some((rec) => rec.state === "needs_user" && section.phaseNames.includes(rec.phase));
  if (blocked) return "failed";
  if (recovery) {
    const advising = Object.values(recovery).some((rec) => (rec.state === "advising" || rec.state === "retrying") && section.phaseNames.includes(rec.phase));
    if (advising) return "running";
  }
  if (mapped.some((phase) => phase.status === "running")) return "running";
  if (mapped.some((phase) => phase.status === "failed")) return "failed";
  if (mapped.every((phase) => phase.status === "completed")) return "done";
  return "pending";
}

// 「重新执行」按钮逐阶段露出来，不再依赖「首个失败阶段」判断。

export interface RecoveryNeedsUser {
  phase: string;
  displayPhase: string;
  instruction: string;
  attempts: Array<{ seq: string; round: 1 | 2; attempt: number; rootCause?: string; expectedEvidence?: string; error: string; action?: string }>;
}

export function recoveryNeedsUser(run: ProjectDetail["automation"]): RecoveryNeedsUser | null {
  if (!run?.recovery) return null;
  const block = Object.values(run.recovery.phases).find((rec) => rec.state === "needs_user");
  if (!block) return null;
  // 同一 runner 重入 phase 后，老的 attempts 会被归档到 attemptsHistory；UI
  // 要让运营同时看到两轮的诊断。合并后只保留尾部 3 条，按时间顺序，
  // history (round 1) 在前、current (round 2) 在后。
  const history = (block.attemptsHistory ?? []).map((attempt) => ({
    seq: `第 ${attempt.attempt} 次（历史）`,
    round: 1 as const,
    attempt: attempt.attempt,
    rootCause: attempt.diagnosis?.rootCause,
    expectedEvidence: attempt.diagnosis?.expectedEvidence,
    error: attempt.error,
    action: attempt.action,
  }));
  const current = block.attempts.map((attempt) => ({
    seq: `第 ${attempt.attempt} 次`,
    round: 2 as const,
    attempt: attempt.attempt,
    rootCause: attempt.diagnosis?.rootCause,
    expectedEvidence: attempt.diagnosis?.expectedEvidence,
    error: attempt.error,
    action: attempt.action,
  }));
  const attempts = [...history, ...current].slice(-3);
  return {
    phase: block.phase,
    displayPhase: recoveryPhaseDisplay(block.phase),
    instruction: block.userInstruction || "请在 VBK 手动确认后再次保存草稿。",
    attempts,
  };
}

export interface RecoveryAdvisorHint {
  phase: string;
  displayPhase: string;
  currentAttempt: number;
  action?: "advising" | "retrying";
}

export function activeAdvisorHint(run: ProjectDetail["automation"]): RecoveryAdvisorHint | null {
  if (!run?.recovery) return null;
  for (const rec of Object.values(run.recovery.phases)) {
    if (rec.state === "advising") {
      const last = rec.attempts[rec.attempts.length - 1];
      return { phase: rec.phase, displayPhase: recoveryPhaseDisplay(rec.phase), currentAttempt: last?.attempt ?? 1, action: "advising" };
    }
    if (rec.state === "retrying") {
      const last = rec.attempts[rec.attempts.length - 1];
      return { phase: rec.phase, displayPhase: recoveryPhaseDisplay(rec.phase), currentAttempt: (last?.attempt ?? rec.attempts.length) + 1, action: "retrying" };
    }
  }
  return null;
}
