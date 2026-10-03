import { createRoot } from "react-dom/client";
import { useState } from "react";
import { AppStageNav } from "../../../src/renderer/app/views/stage-nav/StageNav";
import { AppTopbar } from "../../../src/renderer/app/views/shell/Topbar";
import { AppWorkspaceReviewSummaryHead, type SummaryViewMode } from "../../../src/renderer/app/views/workspace/review-summary-head";
import type { AppModel } from "../../../src/renderer/app/app.main.model";
import type { ProductWorkflowTask } from "../../../src/shared/contracts";
import layout from "../../../src/renderer/app/views/workspace/layout.module.less";
import "../../../src/renderer/styles/global.css";

function Fixture() {
  const [stage, setStage] = useState("review");
  const [mode, setMode] = useState<SummaryViewMode>("cards");
  const [saved, setSaved] = useState(true);
  const [ready, setReady] = useState(true);
  const [status, setStatus] = useState<ProductWorkflowTask["status"]>("succeeded");
  const task = { id: "task-1", status, stage: "completed", progress: status === "running" ? 42 : 100, message: "本轮任务已完成", error: status === "failed" ? "资源核验失败，请补充景点信息后继续。" : undefined, updatedAt: "2026-10-03T14:39:00Z" } as ProductWorkflowTask;
  const model = {
    product: { id: "product-1", name: "成都周边三日游", status: saved ? "draft_saved" : "review", aiUsage: { events: [], byStage: [], lifetime: { calls: 2, totalTokens: 1500, estimatedCostCny: 0.12 } } },
    stage, openStage: setStage, currentWorkflowTask: task,
    readiness: { ready, completion: ready ? 100 : 80, issues: ready ? [] : [{}, {}] }, reviewStepStatus: ready ? "passed" : "inProgress", vbkStepStatus: saved ? "saved" : "ready",
    vbkStageStatus: { tone: saved ? "saved" : "ready", label: saved ? "草稿已保存到 VBK" : "等待录入", detail: "提交审核与发布仍需在 VBK 手工完成。" },
    productCompletionLabel: ready ? "可以录入" : "还需核查",
    view: "workspace", currentAccountName: "示例账号", accountMenuOpen: false, setProduct() {}, setView() {}, setAccountMenuOpen() {}, vbkLogin: { loggedIn: true },
  } as unknown as AppModel;
  Object.assign(window, { stageFixture: { setStatus, setSaved, setReady } });
  return <main style={{ height: "100vh", display: "flex", flexDirection: "column", minWidth: 0 }}>
    <AppTopbar model={model} />
    <AppStageNav model={model} />
    <section role="tabpanel" id={`stage-panel-${stage}`} aria-labelledby={`stage-${stage}`} className={layout.stageSplit} style={{ gridTemplateColumns: "1fr 1fr" }}>
      <section className={layout.panel}><div className={layout.panelHeader}><strong>{stage === "review" ? "方案协作" : "审查结果汇总"}</strong></div><div style={{ padding: 16 }}>产品详情内容区</div></section>
      <section className={layout.panel}>{stage === "review" ? <AppWorkspaceReviewSummaryHead viewMode={mode} onChangeViewMode={setMode} /> : <div className={layout.panelHeader}><strong>VBK 浏览器</strong></div>}<div id="summary-view-panel" style={{ padding: 16 }}>{mode === "cards" ? "基本信息 / 每日行程 / 资源" : "JSON 产品数据"}</div></section>
    </section>
  </main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
