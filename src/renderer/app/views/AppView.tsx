import { useEffect } from "react";
import type { AppModel } from "../app.main.model";
import { AppWorkspaceWorkflow } from "./workspace";
import { AppWorkspaceHomePage } from "./workspace-home";
import { AppProductsPage } from "./products";
import { AppTasksPage } from "./tasks";
import { AppSettingsPage } from "./settings";
import { AppAccountEditor } from "./account-editor";
import { AppOperationLogPage, useOperationLogState } from "./operation-log";
import { AppRail } from "./shell/Rail";
import { AppTopbar } from "./shell/Topbar";
import { AppStageNav } from "./stage-nav/StageNav";
import { MaybeNotice } from "./notice/Notice";
import type { OperationLogEntry, OperationLogQuery, ProductDetail } from "../../../shared/contracts.js";
import { api, operationStageToSection } from "../helpers";
import styles from "./AppView.module.less";
import shared from "./shared.module.less";

/**
 * 应用顶层视图：shell + 内容路由。
 * 所有交互和状态来自 model，子组件只负责呈现与事件冒泡。
 */
export function AppView(model: AppModel) {
  const { view, product, editingAccount, accountMenuOpen, setAccountMenuOpen } = model;

  // 账号浮层打开时，点击浮层与触发按钮之外的区域即关闭（点击外部关闭）。
  useEffect(() => {
    if (!accountMenuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && target.closest("[data-account-menu]")) return;
      setAccountMenuOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [accountMenuOpen, setAccountMenuOpen]);

  return (
    <div className={styles.app}>
      <AppRail model={model} />
      <main className={styles.main}>
        <AppTopbar model={model} />
        {view === "workspace" && product && <AppStageNav model={model} />}
        <MaybeNotice model={model} />
        <ActiveRoute model={model} />
      </main>
      {editingAccount && <AppAccountEditor model={model} />}
    </div>
  );
}

function ActiveRoute({ model }: { model: AppModel }) {
  const { view, product, activeLocalProductId } = model;
  if (view === "settings" && !product) return <AppSettingsPage model={model} />;
  if (view === "products" && !product) return <AppProductsPage model={model} />;
  if (view === "tasks" && !product) return <AppTasksPage model={model} />;
  if (view === "operation-log") return <OperationLogRoute model={model} />;
  // 刷新后 product 还在异步拉取：先渲染一个轻量占位，避免闪现工作台首页
  // 再跳回详情。activeLocalProductId 会在拉取成功 / 失败后被清掉，此分支自动失效。
  if (view === "workspace" && !product && activeLocalProductId) return <RestoringProductPlaceholder />;
  if (view === "workspace" && !product) return <AppWorkspaceHomePage model={model} />;
  if (view === "workspace" && product) return <AppWorkspaceWorkflow model={model} />;
  return null;
}

/**
 * 刷新后的极简占位：避免在拉取最近打开的产品期间闪到工作台首页。
 * 不抢样式主权，沿用 shared.module.less 的 viewSub + dot 视觉。
 */
function RestoringProductPlaceholder() {
  return (
    <section className={styles.restoring} aria-live="polite" aria-busy="true">
      <span className={shared.dot} data-state="ai" />
      <span>正在恢复最近打开的产品…</span>
    </section>
  );
}

/**
 * 操作日志的运行时状态：自身承担加载、筛选、刷新，路由层只负责
 * 装配。这样未来切到持久化数据源时不需要再动 AppView。
 */
function OperationLogRoute({ model }: { model: AppModel }) {
  const { page, loading, refreshedAtLabel, notice, setNotice, refresh } = useOperationLogState(model.apiAvailable);
  const handleRetry = async (entry: OperationLogEntry) => {
    // 真实数据接上后，这里调 automation.retryOnePhase(localProductId, entry.phase)。
    // 现在用 notice 表达「已发起」并让用户感知操作已生效。
    setNotice({ kind: "info", text: `已请求重试「${entry.name}」${entry.phase ? `（${entry.phase}）` : ""}，请在 VBK 浏览器观察执行进度。` });
  };

  // 「详情」：打开该操作关联的产品，并把 VBK 浏览器导航到对应阶段页面。
  // 全局操作（无 localProductId，如登录态检测）没有可跳转的产品，只打开 VBK 浏览器。
  const handleShowDetail = async (entry: OperationLogEntry) => {
    model.setNotice(null);
    const bridge = api();
    if (!bridge) {
      model.setNotice("主进程接口未就绪，无法打开关联产品。");
      return;
    }

    if (!entry.localProductId) {
      model.setView("workspace");
      model.setStage("vbk");
      model.setBrowserOpen(true);
      model.setNotice(`「${entry.name}」是全局操作，没有关联产品；已为你打开 VBK 浏览器。`);
      return;
    }

    // 1) 加载关联产品（拿到 productId 才能构造 VBK 页面 URL）。
    let detail: ProductDetail;
    try {
      detail = await bridge.products.get(entry.localProductId);
    } catch {
      model.setNotice(
        `无法打开日志关联的产品「${entry.productName ?? entry.localProductId}」：该记录属于内置预览样例，本地没有对应产品。接入真实数据源后，这里会直接跳转到该产品。`,
      );
      return;
    }
    model.setProduct(detail);
    model.setView("workspace");
    model.setStage("vbk");
    model.setBrowserOpen(true);

    // 2) 把 VBK 浏览器导航到该操作对应的页面。
    const section = operationStageToSection(entry.stage);
    if (!section) {
      model.setNotice(`已打开产品「${detail.name}」。该操作没有对应的 VBK 页面，可在工作台继续查看。`);
      return;
    }
    const url = section.buildUrl(detail.productId);
    if (!url) {
      model.setNotice(`已打开产品「${detail.name}」。进入「${section.label}」需要先创建产品草稿，请先在销售控制创建产品。`);
      return;
    }
    try {
      await bridge.browser.navigate(url);
      const current = await bridge.browser.currentUrl().catch(() => "");
      if (current) model.setBrowserUrl(current);
      model.setNotice(`已打开产品「${detail.name}」并跳转到「${section.label}」。`);
    } catch (error) {
      model.setNotice(`已打开产品「${detail.name}」，但 VBK 页面跳转失败：${error instanceof Error ? error.message : "请检查浏览器登录状态。"}`);
    }
  };

  const openExportedFile = async (filePath: string) => {
    const bridge = api();
    if (!bridge?.operationLog) {
      setNotice({ kind: "warn", text: "日志打开接口尚未就绪。" });
      return;
    }
    try {
      await bridge.operationLog.open(filePath);
    } catch (error) {
      setNotice({ kind: "warn", text: error instanceof Error ? error.message : "打开日志文件失败。" });
    }
  };

  const handleExport = async (query: OperationLogQuery) => {
    const bridge = api();
    if (!bridge?.operationLog) {
      setNotice({ kind: "warn", text: "日志导出接口尚未就绪。" });
      return;
    }
    try {
      const result = await bridge.operationLog.export(query);
      if (result.canceled) return;
      const filePath = result.path;
      const fileName = filePath?.split(/[\\/]/).pop() ?? "CSV 文件";
      setNotice({
        kind: "info",
        text: `已安全导出 ${result.count} 条日志`,
        action: filePath ? { label: fileName, onClick: () => void openExportedFile(filePath) } : undefined,
      });
    } catch (error) {
      setNotice({ kind: "warn", text: error instanceof Error ? error.message : "日志导出失败。" });
    }
  };

  return (
    <AppOperationLogPage
      loading={loading}
      page={page}
      refreshedAtLabel={refreshedAtLabel}
      onRefresh={(query) => refresh(query)}
      onExport={handleExport}
      onRetry={handleRetry}
      onShowDetail={handleShowDetail}
      notice={notice}
      onDismissNotice={() => setNotice(null)}
    />
  );
}
