import { AppWorkspaceReview } from "./review";
import { AppWorkspaceVbk } from "./vbk";
import type { AppModel } from "../../app.main.model";
import styles from "./index.module.less";

export function AppWorkspaceWorkflow({ model }: { model: AppModel }) {
  const { project, stage } = model;

  if (!project) return null;

  return <section className={styles.workspace} data-stage={stage}>
    <section className={styles.workflowStage} role="tabpanel" id={`stage-panel-${stage}`} aria-labelledby={`stage-${stage}`}>
      {stage === "review" ? <AppWorkspaceReview model={model} /> : <AppWorkspaceVbk model={model} />}
    </section>
  </section>;
}
