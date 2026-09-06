import { PlanningUsagePanel, PlanningUsageToggle, usePlanningUsage } from "./planning-usage";
import { WorkflowTaskSummary } from "../workflow-task/TaskStrip";
import type { AppModel } from "../../app.main.model";
import { AgentConversation } from "./agent-conversation";
import { api } from "../../helpers";
import layout from "./layout.module.less";
import { AppWorkspaceReviewSummary } from "./review-summary";


export function AppWorkspaceReview({ model }: { model: AppModel }) {
  const {
    product,
    input,
    setInput,
    loading,
    splitStyle,
    readiness,
    activeTask,
    setActiveTaskId,
    verificationNote,
    setVerificationNote,
    confirmTask,
    resolveVehicleTask,
    refreshResearchIssues,
    refreshingIssues,
    resolvingVehicleTaskId,
    vbkLogin,
    currentAccountName,
    basicInfoDraft,
    setBasicInfoDraft,
    basicInfoSaving,
    basicInfoErrors,
    basicInfoButlerDefault,
    basicInfoServicePhone,
    fixedInfoReloadToken,
    loadButlerDefault,
    saveSubtitle,
    regenerateSubtitle,
    saveButler,
    savePricing,
    saveInventory,
    saveVehicleCost,
    uploadAndSaveManualCover,
    saveCtripLibraryCover,
    searchCtripLibraryPlaces,
    searchCtripLibraryImages,
    clearError: clearBasicInfoError,
    itinerary,
    expandedDayIndexes,
    setExpandedDayIndexes,
    planningRecovery,
    currentWorkflowTask,
  } = model;

  const usage = usePlanningUsage(product?.aiUsage);
  if (!product) return null;

  const taskList = product.researchTasks ?? [];
  return (
    <div className={layout.reviewWorkspace}>
      <div className={layout.panelHeader}>
        <strong>协作进度</strong>
        <WorkflowTaskSummary task={currentWorkflowTask} />
        {usage.visible && <PlanningUsageToggle label={usage.label} open={usage.open} onToggle={()=>usage.setOpen(!usage.open)} />}
      </div>
      {usage.visible && usage.open && product.aiUsage && <PlanningUsagePanel aiUsage={product.aiUsage} recent={usage.recent} onClose={()=>usage.setOpen(false)} />}

      <div className={layout.stageSplit} style={splitStyle}>
      <AgentConversation
        key={product.id}
        product={product}
        readiness={readiness}
        client={api() ?? undefined}
        input={input}
        setInput={setInput}
        onApproved={() => { model.setStage("vbk"); model.setBrowserOpen(true); }}
      />
      <AppWorkspaceReviewSummary
        product={product}
        readiness={readiness}
        itinerary={itinerary as any}
        taskList={taskList}
        activeTask={activeTask}
        verificationNote={verificationNote}
        setVerificationNote={setVerificationNote}
        setComposerInput={setInput}
        planningRecovery={planningRecovery}
        setActiveTask={setActiveTaskId}
        expandedDayIndexes={expandedDayIndexes}
        setExpandedDayIndexes={setExpandedDayIndexes}
        vbkLoggedIn={Boolean(vbkLogin?.loggedIn)}
        currentAccountName={currentAccountName}
        basicInfoDraft={basicInfoDraft}
        setBasicInfoDraft={setBasicInfoDraft}
        basicInfoSaving={basicInfoSaving}
        basicInfoErrors={basicInfoErrors}
        basicInfoButlerDefault={basicInfoButlerDefault}
        basicInfoServicePhone={basicInfoServicePhone}
        fixedInfoReloadToken={fixedInfoReloadToken}
        loadButlerDefault={loadButlerDefault}
        saveSubtitle={saveSubtitle}
        regenerateSubtitle={regenerateSubtitle}
        saveButler={saveButler}
        savePricing={savePricing}
        saveInventory={saveInventory}
        saveVehicleCost={saveVehicleCost}
        uploadAndSaveManualCover={uploadAndSaveManualCover}
        saveCtripLibraryCover={saveCtripLibraryCover}
        searchCtripLibraryPlaces={searchCtripLibraryPlaces}
        searchCtripLibraryImages={searchCtripLibraryImages}
        clearBasicInfoError={clearBasicInfoError}
        resolvingVehicleTaskId={resolvingVehicleTaskId}
        refreshingIssues={refreshingIssues}
        onRefreshIssues={refreshResearchIssues}
        loading={loading}
        onConfirmTask={() => void confirmTask()}
        onResolveVehicle={() => void resolveVehicleTask()}
      />
      </div>
    </div>
  );
}
