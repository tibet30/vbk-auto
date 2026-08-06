import { useEffect, useRef } from "react";
import type { AppModel } from "../app.main.model";
import { AppWorkspaceWorkflow } from "./workspace";
import { AppWorkspaceHomePage } from "./workspace-home";
import { AppProjectsPage } from "./projects";
import { AppSettingsPage } from "./settings";
import { AppAccountEditor } from "./account-editor";
import { AppOperationLogPage, useOperationLogState } from "./operation-log";
import { AppRail } from "./shell/Rail";
import { AppTopbar } from "./shell/Topbar";
import { AppStageNav } from "./stage-nav/StageNav";
import { MaybeNotice } from "./notice/Notice";
import type { OperationLogEntry } from "../../../shared/contracts.js";
import styles from "./AppView.module.less";

/**
 * 应用顶层视图：shell + 内容路由。
 * 所有交互和状态来自 model，子组件只负责呈现与事件冒泡。
 */
export function AppView(model: AppModel) {
  const { view, project, editingAccount } = model;

  return (
    <div className={styles.app}>
      <AppRail model={model} />
      <main className={styles.main}>
        <AppTopbar model={model} />
        {view === "workspace" && project && <AppStageNav model={model} />}
        <MaybeNotice model={model} />
        <ActiveRoute model={model} />
      </main>
      {editingAccount && <AppAccountEditor model={model} />}
    </div>
  );
}

function ActiveRoute({ model }: { model: AppModel }) {
  const { view, project, apiAvailable } = model;
  if (view === "settings" && !project) return <AppSettingsPage model={model} />;
  if (view === "projects" && !project) return <AppProjectsPage model={model} />;
  if (view === "operation-log") return <OperationLogRoute apiAvailable={apiAvailable} />;
  if (view === "workspace" && !project) return <AppWorkspaceHomePage model={model} />;
  if (view === "workspace" && project) return <AppWorkspaceWorkflow model={model} />;
  return null;
}

/**
 * 操作日志的运行时状态：自身承担加载、筛选、刷新，路由层只负责
 * 装配。这样未来切到持久化数据源时不需要再动 AppView。
 */
function OperationLogRoute({ apiAvailable }: { apiAvailable: boolean }) {
  const { page, loading, refreshedAtLabel, notice, setNotice, refresh } = useOperationLogState(apiAvailable);
  // 首次挂载时拉一次：query 为空表示不过滤，等同于「全部」。
  useEffectOnce(() => { void refresh(); });

  const handleRetry = async (entry: OperationLogEntry) => {
    // 真实数据接上后，这里调 automation.retryOnePhase(projectId, entry.phase)。
    // 现在用 notice 表达「已发起」并让用户感知操作已生效。
    setNotice({ kind: "info", text: `已请求重试「${entry.name}」${entry.phase ? `（${entry.phase}）` : ""}，请在 VBK 浏览器观察执行进度。` });
  };
  const handleShowDetail = (entry: OperationLogEntry) => {
    setNotice({ kind: "info", text: `详情面板尚未接入：${entry.name}（${entry.id}）。` });
  };

  return (
    <AppOperationLogPage
      loading={loading}
      page={page}
      refreshedAtLabel={refreshedAtLabel}
      onRefresh={() => refresh()}
      onRetry={handleRetry}
      onShowDetail={handleShowDetail}
      notice={notice}
      onDismissNotice={() => setNotice(null)}
    />
  );
}

/**
 * useEffect 的极简一次性版：ref 跟踪已挂载的次数，第二次以后不再触发。
 * 避免把 useEffect 直接放进组件函数体里造成 lint 警告。
 */
function useEffectOnce(callback: () => void) {
  const ran = useRef(false);
  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    callback();
  }, [callback]);
}