import { LoaderCircle, ShieldCheck, Truck } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type {
  ContactCardSelection,
  CtripLibraryImageCandidate,
  CtripLibraryPlaceCandidate,
  CtripLibraryPlaceSearchResult,
  CtripLibrarySearchResult,
  ProjectDetail,
  ProjectReadiness,
  ResearchTask,
} from "../../../../shared/contracts-types.js";
import { fieldStateLabel, isVehicleResourceTask } from "../../helpers";
import shared from "../shared.module.less";
import layout from "./layout.module.less";
import { AppWorkspaceReviewSummaryBasicInfo } from "./review-summary-basic-info";
import { AppWorkspaceReviewSummaryHead, type SummaryViewMode } from "./review-summary-head";
import { AppWorkspaceReviewSummaryItinerary, type ItineraryDay } from "./review-summary-itinerary";
import { AppWorkspaceReviewSummaryJson } from "./review-summary-json";
import { AppWorkspaceReviewSummaryOpenIssues } from "./review-summary-open-issues";
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
  /** 当前登录的 VBK 账号名（来自 vbkLogin.accountName），用于管家联系人默认值与状态引导。 */
  currentAccountName?: string | null;
  basicInfoDraft?: Record<string, string>;
  setBasicInfoDraft?: Dispatch<SetStateAction<Record<string, string>>>;
  basicInfoSaving?: string | null;
  basicInfoErrors?: Record<string, string>;
  basicInfoButlerDefault?: ContactCardSelection | null;
  basicInfoServicePhone?: string | null;
  loadButlerDefault?: (projectId: string, accountName: string | null) => Promise<void> | void;
  onOpenAccountEditor?: () => void;
  saveSubtitle?: (projectId: string) => Promise<void> | void | undefined;
  saveButler?: (projectId: string, selection: ContactCardSelection | null) => Promise<void> | void | undefined;
  savePricing?: (projectId: string, adult: number, child: number, minimumTravelers: number) => Promise<void> | void | undefined;
  saveVehicleCost?: (projectId: string, value: number | null) => Promise<void> | void | undefined;
  uploadAndSaveManualCover?: (projectId: string, args: { file: { name: string; type: string; base64: string } }) => Promise<import("../../../../shared/contracts-types.js").ManualUploadCoverMeta | null>;
  saveCtripLibraryCover?: (projectId: string, args: { candidate: CtripLibraryImageCandidate }) => Promise<boolean>;
  searchCtripLibraryPlaces?: (projectId: string, args: { keyword: string }) => Promise<CtripLibraryPlaceSearchResult | null>;
  searchCtripLibraryImages?: (projectId: string, args: { keyword: string; place: CtripLibraryPlaceCandidate }) => Promise<CtripLibrarySearchResult | null>;
  clearBasicInfoError?: (field: string) => void;
  resolvingVehicleTaskId: string | null;
  loading: boolean;
  onConfirmTask: () => Promise<void> | void;
  onResolveVehicle: () => Promise<void> | void;
  refreshingIssues: boolean;
  onRefreshIssues: () => Promise<void> | void;
}

/** 从项目名反解目的地 / 规格 / 形态 — 仅供头部概览展示，不参与业务逻辑。 */
function parseProjectSpec(name: string): { destination: string; spec: string; form: "privateTour" | "groupTour" | "unknown" } {
  const match = name.match(/^(.+?)(\d+)\s*天\s*(\d+)\s*晚\s*(.+)$/);
  if (!match) return { destination: name, spec: "本地草稿", form: "unknown" };
  const kind = match[4];
  const form: "privateTour" | "groupTour" = kind.includes("跟团") ? "groupTour" : "privateTour";
  return { destination: match[1], spec: `${match[2]} 天 ${match[3]} 晚`, form };
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
  currentAccountName,
  basicInfoDraft,
  setBasicInfoDraft,
  basicInfoSaving,
  basicInfoErrors,
  basicInfoButlerDefault,
  basicInfoServicePhone,
  loadButlerDefault,
  onOpenAccountEditor,
  saveSubtitle,
  saveButler,
  savePricing,
  saveVehicleCost,
  uploadAndSaveManualCover,
  saveCtripLibraryCover,
  searchCtripLibraryPlaces,
  searchCtripLibraryImages,
  clearBasicInfoError,
  resolvingVehicleTaskId,
  loading,
  onConfirmTask,
  onResolveVehicle,
  refreshingIssues,
  onRefreshIssues,
}: ReviewSummaryProps) {
  const { destination, spec, form } = parseProjectSpec(project.name);
  const ready = readiness.ready;
  const headlineTone: "ready" | "blocked" | "neutral" = ready ? "ready" : readiness.issues.length > 0 ? "blocked" : "neutral";

  // 默认走卡片视图；切到 JSON 实时数据是「主动要求看」，不是默认体验。
  // 每次切换项目都强制回到卡片视图，避免进入新项目后还是 JSON 视图造成迷惑。
  const [viewMode, setViewMode] = useState<SummaryViewMode>("cards");
  const [copyState, setCopyState] = useState<"idle" | "copied">("idle");
  const [itineraryCollapsed, setItineraryCollapsed] = useState(false);
  const [basicInfoCollapsed, setBasicInfoCollapsed] = useState(false);
  const [openIssuesCollapsed, setOpenIssuesCollapsed] = useState(false);
  useEffect(() => {
    setViewMode("cards");
    setCopyState("idle");
    setItineraryCollapsed(false);
    setBasicInfoCollapsed(false);
    setOpenIssuesCollapsed(false);
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
  const isProductEmpty = !project.product
    || !Array.isArray((project.product as Record<string, unknown>).itinerary)
    || ((project.product as Record<string, unknown>).itinerary as unknown[]).length === 0;
  const planningGenerating = planningRecovery?.status === "pending" || planningRecovery?.status === "running";
  const planningPartial = planningRecovery?.status === "completed" && planningRecovery.allStagesCompleted === false;
  const isGenerating = planningGenerating || (loading && isProductEmpty);
  const showPartialGeneration = (planningGenerating || planningPartial) && !isProductEmpty;
  const showTaskFooter = viewMode === "cards" && !isGenerating;

  const completedStages = planningRecovery?.completed?.length ?? 0;
  const progressValue = planningGenerating || planningPartial
    ? `${completedStages}/7`
    : isGenerating ? "—" : `${readiness.completion}%`;
  const progressCaption = planningGenerating || planningPartial
    ? "生成进度"
    : isGenerating ? "生成中" : "就绪度";
  const progressPercent = planningGenerating || planningPartial
    ? Math.min(100, (completedStages / 7) * 100)
    : isGenerating ? 0 : Math.min(100, Math.max(0, readiness.completion));
  const readinessLabel = ready
    ? "可以录入"
    : isGenerating
      ? "AI 正在生成…"
      : `${readiness.issues.length} 项待处理`;
  const readinessState: "confirmed" | "researching" | "needsConfirmation" | "blocked" = ready
    ? "confirmed"
    : isGenerating
      ? "researching"
      : "needsConfirmation";

  // 「基础信息」模块所需的全部 prop 都已从父级传进来才渲染；任何一个缺失时
  // 退化到旧的"未挂载"路径，避免新模块意外接管部分功能。
  const basicInfoReady = Boolean(
    basicInfoDraft
    && setBasicInfoDraft
    && basicInfoSaving !== undefined
    && basicInfoErrors
    && basicInfoButlerDefault !== undefined
    && loadButlerDefault
    && basicInfoServicePhone !== undefined
    && onOpenAccountEditor
    && saveSubtitle
    && saveButler
    && savePricing
    && saveVehicleCost
    && uploadAndSaveManualCover
    && saveCtripLibraryCover
    && searchCtripLibraryPlaces
    && searchCtripLibraryImages
    && clearBasicInfoError,
  );

  return (
    <aside className={`${layout.panel} ${styles.summary}`} aria-label="审查结果概要">
      <AppWorkspaceReviewSummaryHead
        destination={destination}
        spec={spec}
        form={form}
        viewMode={viewMode}
        onChangeViewMode={setViewMode}
        readinessLabel={readinessLabel}
        readinessState={readinessState}
        progressValue={progressValue}
        progressCaption={progressCaption}
        progressPercent={progressPercent}
        heroTone={isGenerating ? "neutral" : headlineTone}
      />

      {viewMode === "cards" ? (
        <div id="summary-view-panel" role="tabpanel" aria-labelledby="summary-view-cards" className={styles.cardsPane}>
          {isGenerating && !showPartialGeneration ? (
            <GeneratingSkeleton />
          ) : (
            <div className={styles.scroll}>
              {showPartialGeneration && (
                <div className={styles.generatingPane} role="status" aria-live="polite">
                  <strong className={styles.generatingTitle}>
                    {planningPartial ? "方案已生成部分结果，等待继续规划" : `AI 正在生成：${planningRecovery?.currentStageLabel ?? "当前阶段"}`}
                  </strong>
                  <small className={styles.generatingHint}>
                    已完成 {completedStages}/7 个阶段，已生成内容会逐步显示。
                  </small>
                </div>
              )}

              {/* 基础信息：紧凑表单，紧贴在「每日行程」上方。 */}
              {basicInfoReady && basicInfoDraft && setBasicInfoDraft && basicInfoSaving !== undefined && basicInfoErrors && loadButlerDefault && basicInfoServicePhone !== undefined && onOpenAccountEditor && saveSubtitle && saveButler && savePricing && saveVehicleCost && uploadAndSaveManualCover && saveCtripLibraryCover && searchCtripLibraryPlaces && searchCtripLibraryImages && clearBasicInfoError && (
                <AppWorkspaceReviewSummaryBasicInfo
                  project={project}
                  currentAccountName={currentAccountName ?? null}
                  savingField={basicInfoSaving}
                  errors={basicInfoErrors}
                  draft={basicInfoDraft}
                  setDraft={setBasicInfoDraft}
                  accountButlerDefault={basicInfoButlerDefault ?? null}
                  accountServicePhone={basicInfoServicePhone ?? null}
                  loadAccountFixedInfo={loadButlerDefault}
                  onOpenAccountEditor={onOpenAccountEditor}
                  saveSubtitle={saveSubtitle}
                  saveButler={saveButler}
                  savePricing={savePricing}
                  saveVehicleCost={saveVehicleCost}
                  uploadAndSaveManualCover={uploadAndSaveManualCover}
                  saveCtripLibraryCover={saveCtripLibraryCover}
                  searchCtripLibraryPlaces={searchCtripLibraryPlaces}
                  searchCtripLibraryImages={searchCtripLibraryImages}
                  clearError={clearBasicInfoError}
                  collapsed={basicInfoCollapsed}
                  onToggleCollapsed={() => setBasicInfoCollapsed((v) => !v)}
                />
              )}

              <AppWorkspaceReviewSummaryItinerary
                projectId={project.id}
                days={itinerary}
                expandedDayIndex={expandedDayIndex}
                onToggle={(index) => setExpandedDayIndex(expandedDayIndex === index ? null : index)}
                collapsed={itineraryCollapsed}
                onToggleCollapsed={() => setItineraryCollapsed((value) => !value)}
              />

              <AppWorkspaceReviewSummaryOpenIssues
                readiness={readiness}
                taskList={taskList}
                setComposerInput={setComposerInput}
                setVerificationNote={setVerificationNote}
                setActiveTask={setActiveTask}
                collapsed={openIssuesCollapsed}
                onToggleCollapsed={() => setOpenIssuesCollapsed((v) => !v)}
                refreshing={refreshingIssues}
                onRefresh={onRefreshIssues}
              />
            </div>
          )}

          {showTaskFooter && activeTask && !activeTask.state.match(/confirmed|resolved/) ? (
            <ActiveTaskFooter
              activeTask={activeTask}
              verificationNote={verificationNote}
              setVerificationNote={setVerificationNote}
              loading={loading}
              vbkLoggedIn={vbkLoggedIn}
              resolvingVehicleTaskId={resolvingVehicleTaskId}
              onConfirm={() => void onConfirmTask()}
              onResolveVehicle={() => void onResolveVehicle()}
            />
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

/** 加载骨架：放在 review-summary.tsx 内，因为只此一处用，不另开文件。 */
function GeneratingSkeleton() {
  return (
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
  );
}

interface ActiveTaskFooterProps {
  activeTask: ResearchTask;
  verificationNote: string;
  setVerificationNote: (value: string) => void;
  loading: boolean;
  vbkLoggedIn: boolean;
  resolvingVehicleTaskId: string | null;
  onConfirm: () => void;
  onResolveVehicle: () => void;
}

function ActiveTaskFooter({
  activeTask,
  verificationNote,
  setVerificationNote,
  loading,
  vbkLoggedIn,
  resolvingVehicleTaskId,
  onConfirm,
  onResolveVehicle,
}: ActiveTaskFooterProps) {
  return (
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
            onClick={onResolveVehicle}
          >
            {resolvingVehicleTaskId === activeTask.id ? <LoaderCircle size={14} aria-hidden="true" /> : <Truck size={14} aria-hidden="true" />}
            {vbkLoggedIn ? "估算并匹配资源组" : "先登录 VBK"}
          </button>
        )}
        <button
          className={shared.btn}
          data-variant="primary"
          onClick={onConfirm}
          disabled={loading || !verificationNote.trim()}
        >
          {loading ? <LoaderCircle size={15} aria-hidden="true" /> : <ShieldCheck size={15} aria-hidden="true" />}
          保存并写入
        </button>
      </div>
    </footer>
  );
}
