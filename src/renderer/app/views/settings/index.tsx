import type { AppModel } from "../../app.main.model";
import shared from "../shared.module.less";
import styles from "./index.module.less";
import { AgentToolsBlock } from "./agent-tools-block";
import { TibetServiceBlock } from "./tibet-service-block";
import { VbkLoginBlock } from "./vbk-login-block";
import { AppAccountBlock } from "./app-account-block";
import { NotificationBlock } from "./notification-block";
import { UpdateBlock } from "./update-block";

export function AppSettingsPage({ model }: { model: AppModel }) {
  return <div className={styles.settingsPage}>
    <header className={styles.settingsPageHead}>
      <h1>设置</h1>
      <p className={shared.viewSub}>连接 VBK 服务，保证 AI 与浏览器可持续运行。</p>
    </header>
    <div className={styles.settingsStack}>
      <AppAccountBlock />
      <UpdateBlock />
      <NotificationBlock model={model} />
      <VbkLoginBlock model={model} />
      <AgentToolsBlock />
      <TibetServiceBlock />
    </div>
  </div>;
}
