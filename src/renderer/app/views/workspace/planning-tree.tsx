import { useMemo, useState } from "react";
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
import { api } from "../../helpers";
import shared from "../shared.module.less";
import styles from "./planning-tree.module.less";

const STAGES: Array<{ id: PlanningMajorStage; label: string; description: string; invalidates: string }> = [
  { id: "foundation", label: "产品骨架", description: "省市、天数、形态与交通骨架", invalidates: "产品骨架、行程规划和全部产品补全数据" },
  { id: "itinerary", label: "行程规划", description: "候选景点、真实 POI 与逐日编排", invalidates: "景点池、POI、逐日行程和全部产品补全数据" },
  { id: "completion", label: "产品补全", description: "文案、商业信息、封面与用车资源", invalidates: "副标题、展示、商业信息、封面和用车资源组" },
];

const NODE_LABELS: Record<PlanningNodeId, string> = {
  skeleton: "解析并写入骨架",
  spotCandidates: "AI 推荐景点池",
  poiResolution: "查询真实 POI",
  itineraryDraft: "编排每天行程",
  copy: "副标题 / Operation Notes",
  presentation: "推荐语 / 卖点 / 分类",
  commercial: "套餐 / 价格 / 库存 / Release",
  cover: "真实封面",
  vehicleResource: "私家团用车资源组",
  finalValidation: "最终准入检查",
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

export function PlanningTree(props: {
  productId: string;
  plan?: PlanningPlanV2;
  planningBusy: boolean;
  onResume(): Promise<void>;
}) {
  const { productId, plan, planningBusy, onResume } = props;
  const [rerunning, setRerunning] = useState<PlanningMajorStage | null>(null);
  const [collapsed, setCollapsed] = useState<Partial<Record<PlanningMajorStage, boolean>>>({});
  const nodes = plan?.nodes ?? [];
  const currentMajor = nodes.find((node) => node.id === plan?.currentNode)?.majorStage;
  const hasFailure = (stage: PlanningMajorStage) => nodes.some((node) =>
    node.majorStage === stage && (node.status === "failed" || node.status === "blocked"));
  const poiSummary = useMemo(() => {
    if (!plan) return "";
    const recommended = plan.poiCandidates.length;
    const matched = plan.poiCandidates.filter((item) => item.status === "resolved" || item.status === "selected").length;
    const selected = plan.poiCandidates.filter((item) => item.status === "selected").length;
    return recommended ? `推荐 ${recommended} / 命中 ${matched} / 采用 ${selected}` : "";
  }, [plan]);

  const rerun = async (stage: PlanningMajorStage) => {
    const definition = STAGES.find((item) => item.id === stage)!;
    if (!window.confirm(`重做“${definition.label}”将清除：${definition.invalidates}。\n\n产品 UUID、目的地、天数、形态、供应商编号和账号固定信息会保留。是否继续？`)) return;
    setRerunning(stage);
    try {
      await api()!.planning.rerunMajorStage(productId, stage);
    } finally {
      setRerunning(null);
    }
  };

  const resumable = plan && (plan.status === "needs_user" || plan.status === "failed");
  return (
    <section className={styles.tree} aria-label="三阶段产品规划树">
      <div className={styles.treeHead}>
        <div>
          <strong>生成规划</strong>
          <span>{plan ? overallLabel(plan) : "旧产品需要按三阶段流程重新规划"}</span>
        </div>
        {resumable && (
          <button className={`${shared.btn} ${shared.btnSm}`} data-variant="ai" type="button" disabled={planningBusy} onClick={() => void onResume()}>
            {planningBusy ? <LoaderCircle size={13} className={styles.spin} /> : <RotateCcw size={13} />}
            从失败节点继续
          </button>
        )}
      </div>
      <div className={styles.scroller} tabIndex={0} aria-label="规划阶段，可水平滚动">
        <ol className={styles.stageList}>
          {STAGES.map((stage, index) => {
            const stageNodes = nodes.filter((node) => node.majorStage === stage.id);
            const expandedByState = currentMajor === stage.id || hasFailure(stage.id);
            const isCollapsed = collapsed[stage.id] ?? (!expandedByState && stageNodes.every((node) => node.status === "completed" || node.status === "skipped"));
            const state = majorStageState(stageNodes, plan);
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
                      <strong>{stage.label}</strong>
                      <small>{stage.description}</small>
                    </span>
                    {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                  </button>
                  <button
                    className={styles.rerun}
                    type="button"
                    disabled={Boolean(rerunning) || plan?.status === "running" || (!plan && stage.id !== "foundation")}
                    onClick={() => void rerun(stage.id)}
                  >
                    {rerunning === stage.id ? <LoaderCircle size={12} className={styles.spin} /> : <RotateCcw size={12} />}
                    {!plan && stage.id === "foundation" ? "按新流程规划" : "重做此阶段"}
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
    </section>
  );
}

function placeholderNodes(stage: PlanningMajorStage): PlanningNodeState[] {
  const ids = stage === "foundation" ? ["skeleton"]
    : stage === "itinerary" ? ["spotCandidates", "poiResolution", "itineraryDraft"]
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

function fallbackText(node: PlanningNodeState): string {
  if (node.status === "blocked") return "登录恢复后可从此处继续，不消耗业务尝试次数";
  if (node.status === "failed") return "校验未通过，可查看错误后继续或重做阶段";
  return node.status === "pending" ? "等待上游准入通过" : "节点已处理";
}

function overallLabel(plan: PlanningPlanV2): string {
  if (plan.status === "completed") return "规划完成，已进入产品审查";
  if (plan.status === "running") return "正在运行，节点通过后即写入 Tibet";
  if (plan.status === "needs_user") return "流程已暂停，请处理失败或登录阻塞节点";
  return "等待开始";
}
