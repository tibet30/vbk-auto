/**
 * 三阶段产品规划树（PlanningTree）主组件：
 *   - 头部（toggle + 总体状态 + 重做入口 + 用量 + 就绪度徽章）；
 *   - 三个阶段列表：每个阶段显示节点、stage 状态聚合、重做按钮、阶段折叠；
 *   - 行程采用对话框（adoption card / adoption error）；
 *   - 重做确认弹窗（由父组件传入）。
 *
 * 子文件：
 *   - constants.ts  STAGES / NODE_LABELS / RERUN_FALLBACK_NODES / STATUS_LABELS；
 *   - helpers.tsx   纯函数（resolveActivePlanningNode / statusIcon / overallLabel...）；
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, LoaderCircle, RotateCcw, Check } from "lucide-react";
import type { PlanningMajorStage, PlanningPlanV2 } from "../../../../../shared/contracts-planning";
import type { ProductWorkflowTask } from "../../../../../shared/contracts";
import type { ProductAiUsage } from "../../../../../shared/contracts-ai-usage";
import shared from "../shared.module.less";
import { WorkflowTaskSummary } from "../../workflow-task/TaskStrip";
import { PlanningRerunConfirmDialog } from "../planning-rerun-confirm-dialog";
import { PlanningUsagePanel, PlanningUsageToggle, usePlanningUsage } from "../planning-usage";
import styles from "../planning-tree.module.less";
import { NODE_LABELS, RERUN_FALLBACK_NODES, STAGES, STATUS_LABELS } from "./constants.js";
import {
  fallbackText,
  majorStageState,
  overallLabel,
  overallStatusIcon,
  placeholderNodes,
  resolveActivePlanningNode,
  stageStatusIcon,
  stageStatusLabel,
  statusIcon,
} from "./helpers.js";

export interface PlanningTreeProps {
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
}

export function PlanningTree(props: PlanningTreeProps) {
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