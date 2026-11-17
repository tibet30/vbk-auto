import type { AppModel } from "../../app.main.model";
import { AgentWorkspacePage } from "../agent";
import { LoginBrowserPanel } from "./LoginBrowserPanel";
import styles from "./index.module.less";

export function AppWorkspaceHomePage({ model }: { model: AppModel }) {
  const { loginPanelOpen } = model;
  // 登录打开时，VBK 是唯一任务面：全量展示嵌入式页面，完成后由用户手动确认登录态。
  const stageClass = loginPanelOpen ? styles.homeStageOpen : styles.homeStage;

  return <section className={stageClass} data-login-open={loginPanelOpen ? "true" : "false"}>
    {!loginPanelOpen && <AgentWorkspacePage model={model} />}
    {loginPanelOpen && <LoginBrowserPanel model={model} />}
  </section>;
}
