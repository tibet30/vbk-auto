import {
  Braces,
  CalendarDays,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  CircleHelp,
  LayoutGrid,
  ListChecks,
  LoaderCircle,
  MapPin,
  ShieldCheck,
  Truck,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { ProjectDetail, ProjectReadiness, ResearchTask } from "../../../../shared/contracts-types.js";
import { fieldStateLabel, formatIssueGuidance, isVehicleResourceTask } from "../../helpers";
import shared from "../shared.module.less";
import layout from "./layout.module.less";
import { AppWorkspaceReviewSummaryItinerary, type ItineraryDay } from "./review-summary-itinerary";
import { AppWorkspaceReviewSummaryJson } from "./review-summary-json";
import styles from "./review-summary.module.less";

interface ReviewSummaryProps {
  project: ProjectDetail;
  readiness: ProjectReadiness;
  itinerary: ItineraryDay[];
  taskList: ResearchTask[];
  activeTask: ResearchTask | undefined;
  verificationNote: string;
  setVerificationNote: (value: string) => void;
  setComposerInput?: (value: string) => void;
  planningRecovery?: { status: string; currentStageLabel?: string; completed?: string[]; allStagesCompleted?: boolean } | null;
  setActiveTask: (id: string | null) => void;
  expandedDayIndex: number | null;
  setExpandedDayIndex: (value: number | null) => void;
  vbkLoggedIn: boolean;
  resolvingVehicleTaskId: string | null;
  loading: boolean;
  onConfirmTask: () => Promise<void> | void;
  onResolveVehicle: () => Promise<void> | void;
}

type SummaryViewMode = "cards" | "json";

/** 从项目名反解目的地 / 规格 / 形态 — 仅供头部概览展示，不参与业务逻辑。 */
function parseProjectSpec(name: string): { destination: string; spec: string; form: "privateTour" | "groupTour" | "unknown" } {
  const match = name.match(/^(.+?)(\d+)\s*天\s*(\d+)\s*晚\s*(.+)$/);
  if (!match) return { destination: name, spec: "本地草稿", form: "unknown" };
  const kind = match[4];
  const form: "privateTour" | "groupTour" = kind.includes("跟团") ? "groupTour" : "privateTour";
  return { destination: match[1], spec: `${match[2]} 天 ${match[3]} 晚`, form };
}

function issueText(issue: { label: string; detail: string }) {
  return formatIssueGuidance(issue).guidance;
}

function taskTypeLabel(type: ResearchTask["type"]): string {
  return ({ vbk: "VBK 资源", web: "公开来源", cost: "成本估算", image: "图片素材" } as const)[type] || "核查任务";
}

/** 统计产品 JSON 对象顶层键的数量，给运营一个结构直觉；不会递归整个树。 */
function countTopLevelKeys(value: unknown): number {
  if (!value || typeof value !== "object" || Array.isArray(value)) return 0;
  return Object.keys(value as Record<string, unknown>).length;
}

export function AppWorkspaceReviewSummary({
  project,
  readiness,
  itinerary,
  taskList,
  activeTask,
  verificationNote,
  setVerificationNote,
  setComposerInput,
  planningRecovery,
  setActiveTask,
  expandedDayIndex,
  setExpandedDayIndex,
  vbkLoggedIn,
  resolvingVehicleTaskId,
  loading,
  onConfirmTask,
  onResolveVehicle,
}: ReviewSummaryProps) {
  const { destination, spec, form } = parseProjectSpec(project.name);
  const doneTaskCount = taskList.filter((task) => task.state === "confirmed" || task.state === "resolved").length;
  const ready = readiness.ready;
  const headlineTone = ready ? "ready" : readiness.issues.length > 0 ? "blocked" : "neutral";

  // 默认走卡片视图；切到 JSON 实时数据是「主动要求看」，不是默认体验。
  // 每次切换项目都强制回到卡片视图，避免进入新项目后还是 JSON 视图造成迷惑。
  const [viewMode, setViewMode] = useState<SummaryViewMode>("cards");
  const [copyState, setCopyState] = useState<"idle" | "copied">("idle");
  // 每个模块的折叠状态 — 默认全部展开，方便运营一眼看到行程、问题、任务全貌。
  // 需要专注某一项时可以收起其余模块；切到新项目时统一复位。
  const [itineraryCollapsed, setItineraryCollapsed] = useState(false);
  const [issuesCollapsed, setIssuesCollapsed] = useState(false);
  const [tasksCollapsed, setTasksCollapsed] = useState(false);
  useEffect(() => {
    setViewMode("cards");
    setCopyState("idle");
    setItineraryCollapsed(false);
    setIssuesCollapsed(false);
    setTasksCollapsed(false);
  }, [project.id]);

  const { jsonText, jsonBytes, topLevelKeyCount } = useMemo(() => {
    const product = project.product ?? null;
    const text = product ? JSON.stringify(product, null, 2) : "";
    const bytes = new Blob([text]).size;
    return { jsonText: text, jsonBytes: bytes, topLevelKeyCount: countTopLevelKeys(product) };
  }, [project.product]);

  const handleCopyJson = async () => {
    if (!jsonText || topLevelKeyCount === 0) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(jsonText);
      } else {
        // 回退方案：临时 textarea + execCommand，主要应对无 secure context 的环境。
        const textarea = document.createElement("textarea");
        textarea.value = jsonText;
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        document.body.removeChild(textarea);
      }
      setCopyState("copied");
      window.setTimeout(() => setCopyState("idle"), 1600);
    } catch {
      setCopyState("idle");
    }
  };

  // AI 正在生成且 itinerary 为空时（项目刚创建、AI 第一版还未返回），
  // 整个右侧卡片区展示"生成中"骨架，避免显示空产品的就绪度报错。
  // 注意：project.product 在创建时就有 sales/basicInfo/operations 预填字段，
  // 不能用 Object.keys().length === 0 判断，必须用 itinerary 长度。
  const isProductEmpty = !project.product || !Array.isArray((project.product as Record<string, unknown>).itinerary) || ((project.product as Record<string, unknown>).itinerary as unknown[]).length === 0;
  const planningGenerating = planningRecovery?.status === "pending" || planningRecovery?.status === "running";
  const planningPartial = planningRecovery?.status === "completed" && planningRecovery.allStagesCompleted === false;
  const isGenerating = planningGenerating || (loading && isProductEmpty);
  const showPartialGeneration = (planningGenerating || planningPartial) && !isProductEmpty;
  const showTaskFooter = viewMode === "cards" && !isGenerating;
  const showTaskHint = viewMode === "cards" && !isGenerating;

  return (
    <aside className={`${layout.panel} ${styles.summary}`} aria-label="审查结果概要">
      <div className={layout.panelHeader}>
        <div className={layout.panelTitleRow}>
          <span className={layout.panelNum}>02</span>
          <strong className={layout.panelTitle}>审查结果</strong>
        </div>
      </div>

      {/* View-mode switcher — 默认卡片，JSON 用于核对原始结构。 */}
      <div className={styles.modeBar} role="toolbar" aria-label="审查结果展示方式">
        <div className={styles.modeTabs} role="tablist" aria-label="切换卡片或 JSON 视图">
          <button
            type="button"
            role="tab"
            id="summary-view-cards"
            aria-controls="summary-view-panel"
            aria-selected={viewMode === "cards"}
            tabIndex={viewMode === "cards" ? 0 : -1}
            className={styles.modeTab}
            data-active={viewMode === "cards"}
            onClick={() => setViewMode("cards")}
          >
            <LayoutGrid size={12} aria-hidden="true" />
            卡片视图
          </button>
          <button
            type="button"
            role="tab"
            id="summary-view-json"
            aria-controls="summary-view-panel"
            aria-selected={viewMode === "json"}
            tabIndex={viewMode === "json" ? 0 : -1}
            className={styles.modeTab}
            data-active={viewMode === "json"}
            onClick={() => setViewMode("json")}
          >
            <Braces size={12} aria-hidden="true" />
            JSON 数据
          </button>
        </div>
        <span className={styles.modeBarMeta}>
          <span className={shared.state} data-state={ready ? "confirmed" : isGenerating ? "researching" : "needsConfirmation"}>
            {ready ? "可以录入" : isGenerating ? "AI 正在生成…" : `${readiness.issues.length} 项待处理`}
          </span>
        </span>
      </div>

      {viewMode === "cards" ? (
        <div id="summary-view-panel" role="tabpanel" aria-labelledby="summary-view-cards" className={styles.cardsPane}>
          <section className={styles.hero} data-tone={isGenerating ? "neutral" : headlineTone}>
            <div className={styles.heroMain}>
              <div className={styles.heroDestinationRow}>
                <span className={styles.heroIcon}><MapPin size={13} aria-hidden="true" /></span>
                <strong className={styles.heroDestination}>{destination}</strong>
                <span className={styles.heroForm} data-form={form}>{form === "groupTour" ? "跟团游" : form === "privateTour" ? "私家团" : "草稿"}</span>
              </div>
              <small className={styles.heroSpec}>{spec}</small>
            </div>
            <div className={styles.heroProgressBlock}>
            <div className={styles.heroProgressValue}>
                <strong>{planningGenerating || planningPartial ? `${planningRecovery?.completed?.length ?? 0}/7` : isGenerating ? "—" : `${readiness.completion}%`}</strong>
                <small>{planningGenerating || planningPartial ? "生成进度" : isGenerating ? "生成中" : "就绪度"}</small>
              </div>
              <div className={styles.heroProgressTrack}>
                <span className={styles.heroProgressFill} style={{ width: planningGenerating || planningPartial ? `${Math.min(100, ((planningRecovery?.completed?.length ?? 0) / 7) * 100)}%` : isGenerating ? "0%" : `${Math.min(100, Math.max(0, readiness.completion))}%` }} />
              </div>
            </div>
          </section>

          {isGenerating && !showPartialGeneration ? (
            <div className={styles.generatingPane} role="status" aria-live="polite">
              <div className={styles.generatingHero}>
                <span className={styles.generatingSpinner} aria-hidden="true">
                  <LoaderCircle size={20} />
                </span>
                <strong className={styles.generatingTitle}>AI 正在生成完整方案…</strong>
                <small className={styles.generatingHint}>通常 20–60 秒，期间可在左侧继续对话补齐要求。</small>
              </div>
              <div className={styles.generatingSkeleton} aria-hidden="true">
                <div className={styles.skelCard}>
                  <div className={styles.skelRow}>
                    <span className={`${styles.skelBar} ${styles.skelBarLg}`} />
                    <span className={`${styles.skelBar} ${styles.skelBarXs}`} />
                  </div>
                  <span className={`${styles.skelBar} ${styles.skelBarFull}`} />
                  <span className={`${styles.skelBar} ${styles.skelBarFull}`} />
                  <span className={`${styles.skelBar} ${styles.skelBarMd}`} />
                </div>
                <div className={styles.skelCard}>
                  <div className={styles.skelRow}>
                    <span className={`${styles.skelBar} ${styles.skelBarLg}`} />
                    <span className={`${styles.skelBar} ${styles.skelBarSm}`} />
                  </div>
                  <span className={`${styles.skelBar} ${styles.skelBarFull}`} />
                  <span className={`${styles.skelBar} ${styles.skelBarMd}`} />
                </div>
                <div className={styles.skelCard}>
                  <div className={styles.skelRow}>
                    <span className={`${styles.skelBar} ${styles.skelBarLg}`} />
                  </div>
                  <span className={`${styles.skelBar} ${styles.skelBarFull}`} />
                  <span className={`${styles.skelBar} ${styles.skelBarSm}`} />
                </div>
              </div>
            </div>
          ) : (
            <div className={styles.scroll}>
              {showPartialGeneration && <div className={styles.generatingPane} role="status" aria-live="polite"><strong className={styles.generatingTitle}>{planningPartial ? "方案已生成部分结果，等待继续规划" : `AI 正在生成：${planningRecovery?.currentStageLabel ?? "当前阶段"}`}</strong><small className={styles.generatingHint}>已完成 {planningRecovery?.completed?.length ?? 0}/7 个阶段，已生成内容会逐步显示。</small></div>}
              <AppWorkspaceReviewSummaryItinerary
                days={itinerary}
                expandedDayIndex={expandedDayIndex}
                onToggle={(index) => setExpandedDayIndex(expandedDayIndex === index ? null : index)}
                collapsed={itineraryCollapsed}
                onToggleCollapsed={() => setItineraryCollapsed((value) => !value)}
              />

              {(readiness.issues.length > 0 || taskList.some(t => !/confirmed|resolved/.test(t.state))) && (
                <section className={styles.collapsible} aria-label="统一待处理事项">
                  <div className={styles.collapsibleHead}><strong className={styles.collapsibleTitle}>待处理事项</strong></div>
                  <div className={styles.collapsibleBody} style={{ maxHeight: 280, overflowY: "auto", minHeight: 0 }}><ul className={styles.issueList} style={{ display: "grid", gap: 6 }}>
                    {readiness.issues.map((issue, index) => <li key={`issue-${issue.label}`} className={styles.issueItem} style={{ display: "grid", gridTemplateColumns: "20px minmax(0,1fr) auto", alignItems: "center", gap: 8 }}><span className={styles.issueIndex}>{index + 1}</span><span className={styles.issueBody}><strong className={styles.issueLabel}>{issue.label}</strong><span className={styles.issueGuidance}>{issue.detail}</span></span><button type="button" style={{ whiteSpace: "nowrap", flexShrink: 0 }} onClick={(event) => { event.preventDefault(); event.stopPropagation(); (setComposerInput ?? setVerificationNote)(`请补齐待处理项：${issue.label}。${issue.detail}`); }}>处理</button></li>)}
                    {taskList.filter(t => !/confirmed|resolved/.test(t.state)).map((task, index) => <li key={`task-${task.type}-${task.label}`} className={styles.issueItem} style={{ display: "grid", gridTemplateColumns: "20px minmax(0,1fr) 48px", alignItems: "center", gap: 8, minWidth: 0 }}><span className={styles.issueIndex}>{readiness.issues.length + index + 1}</span><span className={styles.issueBody} style={{ minWidth: 0, overflow: "hidden" }}><strong className={styles.issueLabel}>{task.label}</strong><span className={styles.issueGuidance} style={{ overflowWrap: "anywhere" }}>{task.detail || "请补充核查信息"}</span></span><button type="button" style={{ width: 48, whiteSpace: "nowrap" }} onClick={(event) => { event.preventDefault(); event.stopPropagation(); (setComposerInput ?? setVerificationNote)(`请核查并处理：${task.label}。完成后说明结果，不要自动提交。`); }}>处理</button></li>)}
                  </ul></div>
                </section>
              )}

              {false && readiness.issues.length > 0 && (
                <section className={styles.collapsible} aria-label="待处理问题" data-collapsed={issuesCollapsed}>
                  <button
                    type="button"
                    className={styles.collapsibleHead}
                    onClick={() => setIssuesCollapsed((value) => !value)}
                    aria-expanded={!issuesCollapsed}
                    aria-controls="review-issues-body"
                  >
                    <span className={styles.collapsibleIcon}><CircleAlert size={13} aria-hidden="true" /></span>
                    <strong className={styles.collapsibleTitle}>待处理问题</strong>
                    <small className={styles.collapsibleMeta}>{readiness.issues.length} 项</small>
                    <span className={styles.collapsibleChevron} aria-hidden="true"><ChevronDown size={12} /></span>
                  </button>
                  <div
                    id="review-issues-body"
                    className={styles.collapsibleBody}
                    data-scrollable={readiness.issues.length > 4}
                  >
                    <ul className={styles.issueList}>
                      {readiness.issues.map((issue, index) => (
                        <li key={`${issue.label}-${index}`} className={styles.issueItem} data-priority={index === 0 ? "high" : "medium"}>
                          <span className={styles.issueIndex}>{index + 1}</span>
                          <span className={styles.issueBody}>
                            <strong className={styles.issueLabel}>{issue.label}</strong>
                            <span className={styles.issueGuidance}>{issueText(issue)}</span>
                          </span>
                          <button type="button" onClick={(event) => { event.preventDefault(); event.stopPropagation(); (setComposerInput ?? setVerificationNote)(`请补齐待处理项：${issue.label}。${issue.detail}`); }}>处理</button>
                        </li>
                      ))}
                    </ul>
                  </div>
                </section>
              )}

              {false && taskList.length > 0 && (
                <section className={styles.collapsible} aria-label="核查任务" data-collapsed={tasksCollapsed}>
                  <button
                    type="button"
                    className={styles.collapsibleHead}
                    onClick={() => setTasksCollapsed((value) => !value)}
                    aria-expanded={!tasksCollapsed}
                    aria-controls="review-tasks-body"
                  >
                    <span className={styles.collapsibleIcon}><ListChecks size={13} aria-hidden="true" /></span>
                    <strong className={styles.collapsibleTitle}>核查任务</strong>
                    <small className={styles.collapsibleMeta}>{`${doneTaskCount} / ${taskList.length} 已确认`}</small>
                    <span className={styles.collapsibleChevron} aria-hidden="true"><ChevronDown size={12} /></span>
                  </button>
                  <div
                    id="review-tasks-body"
                    className={styles.collapsibleBody}
                    data-scrollable={taskList.length > 4}
                  >
                    <ul className={styles.taskList}>
                      {taskList.map((task) => {
                        const isActive = activeTask?.id === task.id;
                        const done = task.state === "confirmed" || task.state === "resolved";
                        return (
                          <li key={task.id}>
                            <button
                              type="button"
                              className={styles.taskRow}
                              data-active={isActive}
                              data-done={done}
                              onClick={() => setActiveTask(task.id)}
                              aria-label={`核查任务：${task.label}`}
                            >
                              <span className={styles.taskMarker}>
                                {done ? <CheckCircle2 size={12} aria-hidden="true" /> : <CircleHelp size={12} aria-hidden="true" />}
                              </span>
                              <span className={styles.taskBody}>
                                <span className={styles.taskLabel}>{task.label}</span>
                                <span className={styles.taskDetail}>{task.detail || "请补充核查信息后保存"}</span>
                              </span>
                              <span className={styles.taskType} data-type={task.type}>{taskTypeLabel(task.type)}</span>
                              <span className={shared.chipMini} data-on={isActive}>
                                {isActive ? "处理中" : done ? "已完成" : "待核查"}
                              </span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                </section>
              )}
            </div>
          )}

          {showTaskFooter && activeTask && !activeTask.state.match(/confirmed|resolved/) ? (
            <footer className={styles.taskDetail} aria-label="当前任务详情">
              <header className={styles.taskDetailHead}>
                <span className={shared.state} data-state={activeTask.state}>{fieldStateLabel(activeTask.state)}</span>
                <strong className={styles.taskDetailTitle}>{activeTask.label}</strong>
              </header>
              <p className={styles.taskDetailText}>{activeTask.detail || "请在 VBK 或公开来源核查后回填结果。"}</p>
              <textarea
                className={styles.taskDetailInput}
                value={verificationNote}
                onChange={(event) => setVerificationNote(event.target.value)}
                placeholder="粘贴核查结果，例如资源组 ID、价格或链接…"
                aria-label="核查结果"
              />
              <div className={styles.taskDetailActions}>
                {isVehicleResourceTask(activeTask) && (
                  <button
                    className={`${shared.btn} ${shared.btnSm}`}
                    type="button"
                    data-variant="secondary"
                    disabled={!vbkLoggedIn || resolvingVehicleTaskId === activeTask.id}
                    onClick={() => void onResolveVehicle()}
                  >
                    {resolvingVehicleTaskId === activeTask.id ? <LoaderCircle size={14} aria-hidden="true" /> : <Truck size={14} aria-hidden="true" />}
                    {vbkLoggedIn ? "估算并匹配资源组" : "先登录 VBK"}
                  </button>
                )}
                <button
                  className={shared.btn}
                  data-variant="primary"
                  onClick={() => void onConfirmTask()}
                  disabled={loading || !verificationNote.trim()}
                >
                  {loading ? <LoaderCircle size={15} aria-hidden="true" /> : <ShieldCheck size={15} aria-hidden="true" />}
                  保存并写入
                </button>
              </div>
            </footer>
          ) : null}

          {showTaskHint && !activeTask && taskList.length > 0 ? (
            <footer className={styles.taskHint} aria-live="polite">
              <CalendarDays size={13} aria-hidden="true" />
              <span>选中上方任一任务以填写核查结果并写入方案。</span>
            </footer>
          ) : null}
        </div>
      ) : (
        <div id="summary-view-panel" role="tabpanel" aria-labelledby="summary-view-json" className={styles.jsonPane}>
          <AppWorkspaceReviewSummaryJson
            jsonText={jsonText}
            jsonBytes={jsonBytes}
            topLevelKeyCount={topLevelKeyCount}
            copyState={copyState}
            onCopy={() => void handleCopyJson()}
          />
        </div>
      )}
    </aside>
  );
}
