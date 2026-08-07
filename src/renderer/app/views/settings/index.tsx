import type { AppModel } from "../../app.main.model";
import shared from "../shared.module.less";
import styles from "./index.module.less";
import { MiniMaxBlock } from "./minimax-block";
import { VbkLoginBlock } from "./vbk-login-block";

export function AppSettingsPage({ model }: { model: AppModel }) {
  return <div className={styles.settingsPage}>
    <header className={styles.settingsPageHead}>
      <h1>设置</h1>
      <p className={shared.viewSub}>连接 VBK 与 MiniMax，保证 AI 与浏览器可持续运行。</p>
    </header>
    <div className={styles.settingsStack}>
      <VbkLoginBlock model={model} />
      <MiniMaxBlock model={model} />
    </div>
  </div>;
}