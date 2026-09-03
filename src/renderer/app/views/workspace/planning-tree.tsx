import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  LoaderCircle,
  LockKeyhole,
  RotateCcw,
} from "lucide-react";
import type {
  PlanningMajorStage,
  PlanningNodeId,
  PlanningNodeState,
  PlanningPlanV2,
} from "../../../../shared/contracts-planning.js";
import type { ProductWorkflowTask } from "../../../../shared/contracts.js";
import type { ProductAiUsage } from "../../../../shared/contracts-ai-usage.js";
import shared from "../shared.module.less";
import { WorkflowTaskSummary } from "../workflow-task/TaskStrip";
import { PlanningRerunConfirmDialog, type PlanningRerunStage } from "./planning-rerun-confirm-dialog";
import { PlanningUsagePanel, PlanningUsageToggle, usePlanningUsage } from "./planning-usage";
import styles from "./planning-tree.module.less";

const STAGES: PlanningRerunStage[] = [
  { id: "foundation", label: "产品骨架", description: "省市、天数、形态与交通骨架", invalidates: "产品骨架、行程规划和全部产品补全数据" },
  { id: "itinerary", label: "行程规划", description: "候选景点、真实 POI、逐日编排与酒店匹配", invalidates: "景点池、POI、逐日行程、酒店候选和全部产品补全数据" },
  { id: "completion", label: "产品补全", description: "文案、商业信息、封面与用车资源", invalidates: "副标题、展示、商业信息、封面和用车资源组" },
];

const NODE_LABELS: Record<PlanningNodeId, string> = {
  skeleton: "解析并写入骨架",
  spotCandidates: "AI 推荐景点池",
  poiResolution: "查询真实 POI",
  itineraryDraft: "编排每天行程",
  hotelResolution: "匹配每日酒店候选",
  copy: "副标题 / Operation Notes",
  presentation: "推荐语 / 卖点 / 分类",
  commercial: "套餐 / 价格 / 库存 / Release",
  cover: "真实封面",
  vehicleResource: "私家团用车资源组",
  finalValidation: "最终准入检查",
};

const RERUN_FALLBACK_NODES: Record<PlanningMajorStage, PlanningNodeId> = {
  foundation: "skeleton",
  itinerary: "spotCandidates",
  completion: "copy",
};

const STATUS_LABELS: Record<PlanningNodeState["status"], string> = {
  pending: "待开始",
  running: "进行中",
  completed: "已完成",
  failed: "未通过",
  blocked: "被阻塞",
  skipped: "不适用",
  invalidated: "已失效",
};

export function resolveActivePlanningNode(
  plan: PlanningPlanV2 | undefined,
  rerunBusy: PlanningMajorStage | null,
): PlanningNodeId | null {
  if (plan?.status === "running") return plan.currentNode;
  return rerunBusy ? RERUN_FALLBACK_NODES[rerunBusy] : null;
}

export function PlanningTree(props: {
  plan?: PlanningPlanV2;
  workflowTask: ProductWorkflowTask | null;
  aiUsage?: ProductAiUsage;
  planningBusy: boolean;
  onResume(): Promise<void>;
  onRerunMajorStage(stage: PlanningMajorStage): Promise<void>;
  rerunBusy: PlanningMajorStage | null;
  itineraryAdoptionBusy: boolean;
  onAcceptItinerary(): Promise<void>;
  /** 就绪度徽章文案（如「可以录入 / N 项待处理 / AI 正在生成…」）。 */
  readinessLabel: string;
  /** 就绪度徽章状态，映射到 shared.state 的 data-state 配色。 */
  readinessState: "confirmed" | "researching" | "needsConfirmation";
  /** 进度数值（如「85% / 3/7 / —」）。 */
  progressValue: string;
  /** 进度数值旁的小标签（生成进度 / 生成中 / 就绪度）。 */
  progressCaption: string;
}) {
  const { plan, workflowTask, aiUsage, planningBusy, onResume, onRerunMajorStage, rerunBusy, itineraryAdoptionBusy, onAcceptItinerary, readinessLabel, readinessState, progressValue, progressCaption } = props;
  const usage = usePlanningUsage(aiUsage);
  const [collapsed, setCollapsed] = useState<Partial<Record<PlanningMajorStage, boolean>>>({});
  const [treeCollapsed, setTreeCollapsed] = useState(false);
  const [rerunStage, setRerunStage] = useState<PlanningMajorStage | null>(null);
  const rerunTriggerRefs = useRef<Partial<Record<PlanningMajorStage, HTMLButtonElement | null>>>({});
  const rerunFocusRef = useRef<HTMLButtonElement | null>(null);
  const nodes = plan?.nodes ?? [];
  const activeNode = resolveActivePlanningNode(plan, rerunBusy);
  const activeNodeLabel = activeNode ? `AI 正在生成 ${NODE_LABELS[activeNode]}` : null;
  const terminalStatus = plan && !activeNodeLabel
    ? { label: overallLabel(plan), status: plan.status }
    : null;
  const poiSummary = useMemo(() => {
    if (!plan) return "";
    const recommended = plan.poiCandidates.length;
    const matched = plan.poiCandidates.filter((item) => item.status === "resolved" || item.status === "selected").length;
    const selected = plan.poiCandidates.filter((item) => item.status === "selected").length;
    const manual = plan.itineraryAdoption?.status === "accepted"
      ? plan.poiCandidates.filter((item) => item.status === "rejected").length
      : 0;
    if (manual > 0) return `推荐 ${recommended} / 命中 ${matched} / 采用 ${selected} / 待手动 ${manual}`;
    return recommended ? `推荐 ${recommended} / 命中 ${matched} / 采用 ${selected}` : "";
  }, [plan]);

  useEffect(() => {
    if (plan?.status === "completed" && !rerunBusy) setTreeCollapsed(true);
  }, [plan?.status, rerunBusy]);

  const rerun = (stage: PlanningMajorStage) => {
    rerunFocusRef.current = rerunTriggerRefs.current[stage] ?? null;
    setRerunStage(stage);
  };
  const confirmRerun = () => {
    if (!rerunStage) return;
    const stage = rerunStage;
    setRerunStage(null);
    // 确认后按钮会立即进入 disabled/busy 状态，先在状态切换前交还焦点。
    rerunTriggerRefs.current[stage]?.focus();
    void onRerunMajorStage(stage);
  };

  const resumable = plan && (plan.status === "needs_user" || plan.status === "failed");
  return (
    <section className={styles.tree} aria-label="三阶段产品规划树">
      <div className={styles.treeHead}>
        <button
          className={styles.treeTitleToggle}
          type="button"
          aria-expanded={!treeCollapsed}
          aria-controls="planning-stage-list"
          onClick={() => setTreeCollapsed((value) => {
            if (value) setCollapsed({});
            return !value;
          })}
        >
          <span className={styles.treeTitleMain}>
            <strong>生成规划</strong>
            {activeNodeLabel ? (
              <span
                className={styles.generationStatus}
                role="status"
                aria-live="polite"
                aria-atomic="true"
                title={activeNodeLabel}
              >
                <LoaderCircle size={13} className={styles.spin} aria-hidden="true" />
                <span>{activeNodeLabel}</span>
              </span>
            ) : !plan ? <span>旧产品需要按三阶段流程重新规划</span> : null}
          </span>
        </button>
        {resumable && (
          <button className={`${shared.btn} ${shared.btnSm}`} data-variant="ai" type="button" disabled={planningBusy || Boolean(rerunBusy) || itineraryAdoptionBusy} onClick={() => void onResume()}>
            {planningBusy ? <LoaderCircle size={13} className={styles.spin} /> : <RotateCcw size={13} />}
            从失败节点继续
          </button>
        )}
        <span className={styles.treeTrailing}>
          {workflowTask ? <WorkflowTaskSummary task={workflowTask} /> : terminalStatus && (
            <span className={styles.overallStatus} data-state={terminalStatus.status} title={terminalStatus.label}>
              {overallStatusIcon(terminalStatus.status, styles.spin)}
              {terminalStatus.label}
            </span>
          )}
          {usage.visible ? (
            <PlanningUsageToggle
              label={usage.label}
              open={usage.open && !treeCollapsed}
              onToggle={() => {
                if (usage.open && !treeCollapsed) {
                  usage.setOpen(false);
                  return;
                }
                setTreeCollapsed(false);
                usage.setOpen(true);
              }}
            />
          ) : null}
          <span className={styles.readinessGroup}>
            <span className={shared.state} data-state={readinessState}>{readinessLabel}</span>
            {!workflowTask ? <span className={styles.progressValue}>
              <strong>{progressValue}</strong>
              <small>{progressCaption}</small>
            </span> : null}
          </span>
          <button
            className={styles.treeTitleChevron}
            type="button"
            aria-label={treeCollapsed ? "展开方案生成" : "收起方案生成"}
            aria-expanded={!treeCollapsed}
            aria-controls="planning-stage-list"
            onClick={() => setTreeCollapsed((value) => {
              if (value) setCollapsed({});
              return !value;
            })}
          >
            <span aria-hidden="true">
              {treeCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
            </span>
          </button>
        </span>
      </div>
      {!treeCollapsed ? (
      <div className={styles.treeBody}>
      {usage.visible && usage.open && usage.aiUsage ? (
        <PlanningUsagePanel
          aiUsage={usage.aiUsage}
          recent={usage.recent}
          onClose={() => usage.setOpen(false)}
        />
      ) : null}
      <div id="planning-stage-list" className={styles.scroller} tabIndex={0} aria-label="规划阶段，可水平滚动">
        <ol className={styles.stageList}>
          {STAGES.map((stage, index) => {
            const stageNodes = nodes.filter((node) => node.majorStage === stage.id);
            const isCollapsed = collapsed[stage.id] ?? false;
            const stageBusy = rerunBusy === stage.id;
            const state = stageBusy ? "running" : majorStageState(stageNodes, plan);
            return (
              <li className={styles.stage} data-state={state} key={stage.id}>
                <header className={styles.stageHead}>
                  <button
                    className={styles.stageToggle}
                    type="button"
                    aria-expanded={!isCollapsed}
                    onClick={() => setCollapsed((value) => ({ ...value, [stage.id]: !isCollapsed }))}
                  >
                    <span className={styles.stageIndex}>{index + 1}</span>
                    <span className={styles.stageTitle}>
                      <strong>
                        {stage.label}
                      </strong>
                      <small>{stage.description}</small>
                    </span>
                    <span className={styles.stageStateSummary} data-state={state}>
                      {stageStatusIcon(state, styles.spin)}
                      {stageStatusLabel(state)}
                    </span>
                  </button>
                  <button
                    className={styles.rerun}
                    type="button"
                    ref={(element) => { rerunTriggerRefs.current[stage.id] = element; }}
                    aria-busy={stageBusy}
                    disabled={Boolean(rerunBusy) || planningBusy || itineraryAdoptionBusy || (!plan && stage.id !== "foundation")}
                    onClick={() => rerun(stage.id)}
                  >
                    {rerunBusy === stage.id ? <LoaderCircle size={12} className={styles.spin} /> : <RotateCcw size={12} />}
                    {rerunBusy === stage.id ? "重做中…" : !plan && stage.id === "foundation" ? "按新流程规划" : "重做此阶段"}
                  </button>
                  <button
                    className={styles.stageExpand}
                    type="button"
                    aria-label={`${isCollapsed ? "展开" : "收起"}${stage.label}`}
                    aria-expanded={!isCollapsed}
                    onClick={() => setCollapsed((value) => ({ ...value, [stage.id]: !isCollapsed }))}
                  >
                    {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                  </button>
                </header>
                {!isCollapsed && (
                  <ol className={styles.nodeList}>
                    {(stageNodes.length ? stageNodes : placeholderNodes(stage.id)).map((node) => (
                      <li className={styles.node} data-state={node.status} key={node.id}>
                        <span className={styles.nodeIcon}>{statusIcon(node.status)}</span>
                        <span className={styles.nodeBody}>
                          <span className={styles.nodeTopline}>
                            <strong>{NODE_LABELS[node.id]}</strong>
                            <small>{STATUS_LABELS[node.status]} · {node.attempts}/3</small>
                          </span>
                          <span className={styles.nodeDetail}>
                            {node.id === "poiResolution" && poiSummary ? poiSummary : node.error || node.summary || fallbackText(node)}
                          </span>
                        </span>
                      </li>
                    ))}
                  </ol>
                )}
              </li>
            );
          })}
        </ol>
      </div>
      {plan?.itineraryAdoption?.status === "pending" && (
        <div className={styles.adoptionCard} role="status" aria-live="polite">
          <strong>行程规划第二阶段已完成，等待补充 POI</strong>
          <span>系统会先自动尝试匹配当前行程的真实 POI，并尽力匹配当前行程的真实 POI；查到的景点会自动绑定。AI 推荐但未命中的景点会删除，用户点名但未命中的景点会保留，但不保证 POI 真实可靠。你也可以在产品审查中手动配置或删除缺失 POI，再重新补全文案、封面、商业信息和用车资源。</span>
          <div className={styles.adoptionActions}>
            <button
              className={`${shared.btn} ${shared.btnSm}`}
              data-variant="ai"
              type="button"
              disabled={itineraryAdoptionBusy || planningBusy || Boolean(rerunBusy)}
              onClick={() => void onAcceptItinerary()}
            >
              {itineraryAdoptionBusy ? <LoaderCircle size={13} className={styles.spin} /> : <Check size={13} />}
              {itineraryAdoptionBusy ? "正在匹配并补全…" : "采用此行程并重新补全产品"}
            </button>
            <span className={styles.adoptionHint}>可继续调整：继续在对话中修改行程，采用前会以最新版本为准。</span>
          </div>
        </div>
      )}
      {plan?.itineraryAdoption?.status === "blocked" && (
        <div className={styles.adoptionError} role="alert">
          <strong>行程尚未采用</strong>
          <span>{plan.itineraryAdoption.error || "有景点未匹配真实 POI，请继续调整后重试。"}</span>
          <div className={styles.adoptionActions}>
            <button
              className={`${shared.btn} ${shared.btnSm}`}
              data-variant="ai"
              type="button"
              disabled={itineraryAdoptionBusy || planningBusy || Boolean(rerunBusy)}
              onClick={() => void onAcceptItinerary()}
            >
              {itineraryAdoptionBusy ? <LoaderCircle size={13} className={styles.spin} /> : <RotateCcw size={13} />}
              {itineraryAdoptionBusy ? "正在重新核验…" : "重新核验并补全"}
            </button>
            <span>也可以继续在对话中调整行程，采用时始终以最新版本为准。</span>
          </div>
        </div>
      )}
      </div>
      ) : null}
      <PlanningRerunConfirmDialog
        stage={rerunStage ? STAGES.find((stage) => stage.id === rerunStage) ?? null : null}
        onCancel={() => setRerunStage(null)}
        onConfirm={confirmRerun}
        returnFocusRef={rerunFocusRef}
      />
    </section>
  );
}

function placeholderNodes(stage: PlanningMajorStage): PlanningNodeState[] {
  const ids = stage === "foundation" ? ["skeleton"]
    : stage === "itinerary" ? ["spotCandidates", "poiResolution", "itineraryDraft", "hotelResolution"]
      : ["copy", "presentation", "commercial", "cover", "vehicleResource", "finalValidation"];
  return ids.map((id) => ({ id: id as PlanningNodeId, majorStage: stage, status: "pending", attempts: 0 }));
}

function majorStageState(nodes: PlanningNodeState[], plan?: PlanningPlanV2) {
  if (nodes.some((node) => node.status === "blocked")) return "blocked";
  if (nodes.some((node) => node.status === "failed")) return "failed";
  if (nodes.some((node) => node.status === "running")) return "running";
  if (nodes.length && nodes.every((node) => node.status === "completed" || node.status === "skipped")) return "completed";
  return plan ? "pending" : "legacy";
}

function statusIcon(status: PlanningNodeState["status"]) {
  if (status === "completed") return <Check size={12} />;
  if (status === "running") return <LoaderCircle size={12} className={styles.spin} />;
  if (status === "failed") return <AlertTriangle size={12} />;
  if (status === "blocked") return <LockKeyhole size={12} />;
  return <Circle size={10} />;
}

function stageStatusIcon(state: ReturnType<typeof majorStageState>, spinClass: string) {
  if (state === "running") return <LoaderCircle size={12} className={spinClass} aria-hidden="true" />;
  if (state === "completed") return <Check size={12} aria-hidden="true" />;
  if (state === "failed") return <AlertTriangle size={12} aria-hidden="true" />;
  if (state === "blocked") return <LockKeyhole size={12} aria-hidden="true" />;
  return <Circle size={10} aria-hidden="true" />;
}

function stageStatusLabel(state: ReturnType<typeof majorStageState>) {
  if (state === "completed") return "已完成";
  if (state === "running") return "进行中";
  if (state === "failed") return "未通过";
  if (state === "blocked") return "被阻塞";
  if (state === "legacy") return "待规划";
  return "待开始";
}

function overallStatusIcon(status: PlanningPlanV2["status"], spinClass: string) {
  if (status === "running") return <LoaderCircle size={13} className={spinClass} aria-hidden="true" />;
  if (status === "completed") return <Check size={13} aria-hidden="true" />;
  if (status === "needs_user" || status === "failed") return <AlertTriangle size={13} aria-hidden="true" />;
  return <Circle size={11} aria-hidden="true" />;
}

function fallbackText(node: PlanningNodeState): string {
  if (node.status === "blocked") return "登录恢复后可从此处继续，不消耗业务尝试次数";
  if (node.status === "failed") return "校验未通过，可查看错误后继续或重做阶段";
  return node.status === "pending" ? "等待上游准入通过" : "节点已处理";
}

function overallLabel(plan: PlanningPlanV2): string {
  if (plan.status === "completed") return "规划已完成，可进入产品审查";
  if (plan.status === "running") return "正在运行，节点通过后即写入 Tibet";
  if (plan.status === "needs_user") return "流程已暂停，请处理失败或登录阻塞节点";
  return "等待开始";
}
