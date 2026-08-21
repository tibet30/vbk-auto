import type { AppModel } from "../../app.main.model";
import shared from "../shared.module.less";
import styles from "./index.module.less";
import { AiProviderBlock } from "./minimax-block";
import { VbkLoginBlock } from "./vbk-login-block";
import { AppAccountBlock } from "./app-account-block";

export function AppSettingsPage({ model }: { model: AppModel }) {
  return <div className={styles.settingsPage}>
    <header className={styles.settingsPageHead}>
      <h1>设置</h1>
      <p className={shared.viewSub}>连接 VBK 与 AI 服务，保证 AI 与浏览器可持续运行。</p>
    </header>
    <div className={styles.settingsStack}>
      <AppAccountBlock />
      <VbkLoginBlock model={model} />
      <AiProviderBlock model={model} />
    </div>
  </div>;
}
