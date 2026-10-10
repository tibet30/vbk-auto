/**
 * 可复制 ID 徽章：
 *   - 等宽字体显示 ID，点击复制到剪贴板；
 *   - 1.6 秒内显示"已复制" + 勾选图标，再回到 idle 状态；
 *   - stopClickPropagation 默认开启，避免被父级 button（产品行 / 面包屑）接收。
 *
 * 使用场景有两种：
 *   - 顶栏里作为面包屑 ID chip：父级是 span，不冲突。
 *   - 产品列表里嵌在 productRowOpen 这个 button 里：产品列表行本身就是
 *     "进入产品"按钮，严格的 HTML 规范不允许在 <button> 里嵌套交互元素；
 *     这里采用了实际产品里常见的折中——使用 <button> 元素获得原生键盘 / a11y 支持，
 *     同时在 click 里默认调用 stopPropagation，避免被外层识别为"打开产品"。
 */

import { Check, Copy } from "lucide-react";
import { type MouseEvent, useState } from "react";
import { copyText } from "../constants";
import styles from "../components.module.less";

export function CopyableId({
  value,
  label = "ID",
  className,
  stopClickPropagation = true,
}: {
  value: string;
  label?: string;
  className?: string;
  /** 调用 event.stopPropagation()，避免被父级 button 接收。默认开启。 */
  stopClickPropagation?: boolean;
}) {
  const [state, setState] = useState<"idle" | "copied">("idle");

  const handleCopy = async (event: MouseEvent<HTMLButtonElement>) => {
    if (stopClickPropagation) event.stopPropagation();
    if (state === "copied" || !value) return;
    const ok = await copyText(value);
    if (!ok) return;
    setState("copied");
    window.setTimeout(() => setState("idle"), 1600);
  };

  return (
    <button
      type="button"
      className={`${styles.copyableId} ${className || ""}`}
      data-state={state}
      onClick={handleCopy}
      title={state === "copied" ? `已复制 ${value}` : `点击复制产品 ID：${value}`}
      aria-label={`复制产品 ID ${value}`}
    >
      <span className={styles.copyableIdLabel}>{label}:</span>
      <span className={styles.copyableIdValue}>{state === "copied" ? "已复制" : value}</span>
      <span className={styles.copyableIdIcon} aria-hidden="true">
        {state === "copied" ? <Check size={10} /> : <Copy size={10} />}
      </span>
    </button>
  );
}