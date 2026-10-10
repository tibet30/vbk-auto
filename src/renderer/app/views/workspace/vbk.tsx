/**
 * workspace 「VBK」路由主组件：左侧审查结果汇总（自动化阶段 / readiness /
 * footer 按钮）+ 右侧 VBK 浏览器面板（路径 / 复制 / 刷新 / 占位 / 待核查条）。
 *
 * 子文件：
 *   - vbk/review.tsx       : 左半屏 AppWorkspaceVbkReview
 *   - vbk/browser-panel.tsx : 右半屏 AppWorkspaceVbkBrowser
 */

import type { AppModel } from "../../app.main.model";
import layout from "./layout.module.less";
import styles from "./vbk.module.less";
import { AppWorkspaceVbkReview } from "./vbk/review.js";
import { AppWorkspaceVbkBrowser } from "./vbk/browser-panel.js";

export function AppWorkspaceVbk({ model }: { model: AppModel }) {
  const { splitStyle } = model;
  return <div className={`${layout.stageSplit} ${styles.vbkSplit}`} style={splitStyle}>
    <AppWorkspaceVbkReview model={model} />
    <AppWorkspaceVbkBrowser model={model} />
  </div>;
}