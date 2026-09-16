import type { ReactNode } from "react";
import { AppStatusBar } from "./StatusBar";
import { UpdateDialog } from "./UpdateDialog";
import styles from "./AppFrame.module.less";

/**
 * 应用外框：主体在上，全局状态栏在下。
 * 状态栏与更新弹窗都在登录判断之外渲染，所以登录页也能看到并执行更新。
 */
export function AppFrame({ children }: { children: ReactNode }) {
  return (
    <div className={styles.frame}>
      <div className={styles.body}>{children}</div>
      <AppStatusBar />
      <UpdateDialog />
    </div>
  );
}
