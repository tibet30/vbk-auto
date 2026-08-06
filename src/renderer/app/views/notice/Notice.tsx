import { TriangleAlert } from "lucide-react";
import type { AppModel } from "../../app.main.model";
import styles from "./Notice.module.less";

/**
 * 临时提示条：只在 model.notice 不为空时浮在主区右上角。
 * 由 AppShell 决定挂载位置，组件本身只负责关闭和文案。
 */
export function AppNotice({ notice, onDismiss }: { notice: string; onDismiss: () => void }) {
  return (
    <div className={styles.notice} role="status" data-tone="warning">
      <TriangleAlert size={15} />
      <span>{notice}</span>
      <button onClick={onDismiss}>关闭</button>
    </div>
  );
}

export function MaybeNotice({ model }: { model: AppModel }) {
  if (!model.notice) return null;
  return <AppNotice notice={model.notice} onDismiss={() => model.setNotice(null)} />;
}