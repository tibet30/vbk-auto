import { AppWorkspaceReview } from "./review";
import { AppWorkspaceVbk } from "./vbk";
import type { AppModel } from "../../app.main.model";
import styles from "./index.module.less";
import { WorkflowTaskStrip } from "../workflow-task/TaskStrip";

export function AppWorkspaceWorkflow({ model }: { model: AppModel }) {
  const { product, stage, currentWorkflowTask } = model;

  if (!product) return null;

  return <section className={styles.workspace} data-stage={stage}>
    {stage === "vbk" ? <WorkflowTaskStrip task={currentWorkflowTask} /> : null}
    <section className={styles.workflowStage} role="tabpanel" id={`stage-panel-${stage}`} aria-labelledby={`stage-${stage}`}>
      {stage === "review" ? <AppWorkspaceReview model={model} /> : <AppWorkspaceVbk model={model} />}
    </section>
  </section>;
}
