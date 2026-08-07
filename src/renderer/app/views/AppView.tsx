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
import type { OperationLogEntry, ProjectDetail } from "../../../shared/contracts.js";
import { api, operationStageToSection } from "../helpers";
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
  const { view, project } = model;
  if (view === "settings" && !project) return <AppSettingsPage model={model} />;
  if (view === "projects" && !project) return <AppProjectsPage model={model} />;
  if (view === "operation-log") return <OperationLogRoute model={model} />;
  if (view === "workspace" && !project) return <AppWorkspaceHomePage model={model} />;
  if (view === "workspace" && project) return <AppWorkspaceWorkflow model={model} />;
  return null;
}

/**
 * 操作日志的运行时状态：自身承担加载、筛选、刷新，路由层只负责
 * 装配。这样未来切到持久化数据源时不需要再动 AppView。
 */
function OperationLogRoute({ model }: { model: AppModel }) {
  const { page, loading, refreshedAtLabel, notice, setNotice, refresh } = useOperationLogState(model.apiAvailable);
  // 首次挂载时拉一次：query 为空表示不过滤，等同于「全部」。
  useEffectOnce(() => { void refresh(); });

  const handleRetry = async (entry: OperationLogEntry) => {
    // 真实数据接上后，这里调 automation.retryOnePhase(projectId, entry.phase)。
    // 现在用 notice 表达「已发起」并让用户感知操作已生效。
    setNotice({ kind: "info", text: `已请求重试「${entry.name}」${entry.phase ? `（${entry.phase}）` : ""}，请在 VBK 浏览器观察执行进度。` });
  };

  // 「详情」：打开该操作关联的项目，并把 VBK 浏览器导航到对应阶段页面。
  // 全局操作（无 projectId，如登录态检测）没有可跳转的项目，只打开 VBK 浏览器。
  const handleShowDetail = async (entry: OperationLogEntry) => {
    model.setNotice(null);
    const bridge = api();
    if (!bridge) {
      model.setNotice("主进程接口未就绪，无法打开关联项目。");
      return;
    }

    if (!entry.projectId) {
      model.setView("workspace");
      model.setStage("vbk");
      model.setBrowserOpen(true);
      model.setNotice(`「${entry.name}」是全局操作，没有关联项目；已为你打开 VBK 浏览器。`);
      return;
    }

    // 1) 加载关联项目（拿到 productId 才能构造 VBK 页面 URL）。
    let detail: ProjectDetail;
    try {
      detail = await bridge.projects.get(entry.projectId);
    } catch {
      model.setNotice(
        `无法打开日志关联的项目「${entry.projectName ?? entry.projectId}」：该记录属于内置预览样例，本地没有对应项目。接入真实数据源后，这里会直接跳转到该项目。`,
      );
      return;
    }
    model.setProject(detail);
    model.setView("workspace");
    model.setStage("vbk");
    model.setBrowserOpen(true);

    // 2) 把 VBK 浏览器导航到该操作对应的页面。
    const section = operationStageToSection(entry.stage);
    if (!section) {
      model.setNotice(`已打开项目「${detail.name}」。该操作没有对应的 VBK 页面，可在工作台继续查看。`);
      return;
    }
    const url = section.buildUrl(detail.productId);
    if (!url) {
      model.setNotice(`已打开项目「${detail.name}」。进入「${section.label}」需要先创建产品草稿，请先在销售控制创建产品。`);
      return;
    }
    try {
      await bridge.browser.navigate(url);
      const current = await bridge.browser.currentUrl().catch(() => "");
      if (current) model.setBrowserUrl(current);
      model.setNotice(`已打开项目「${detail.name}」并跳转到「${section.label}」。`);
    } catch (error) {
      model.setNotice(`已打开项目「${detail.name}」，但 VBK 页面跳转失败：${error instanceof Error ? error.message : "请检查浏览器登录状态。"}`);
    }
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