import type { ComponentPropsWithRef } from "react";
import styles from "./Select.module.less";

export type SelectProps = ComponentPropsWithRef<"select"> & {
  /** 紧凑工具栏使用 compact；已有外层边框的筛选器使用 plain。 */
  controlSize?: "standard" | "compact";
  variant?: "default" | "plain";
};

/** 原生下拉：保留 option、事件、ref 与键盘行为，统一箭头留白。 */
export function Select({ className, controlSize = "standard", variant = "default", ...props }: SelectProps) {
  return <select
    {...props}
    className={[styles.select, className].filter(Boolean).join(" ")}
    data-control-size={controlSize}
    data-variant={variant}
    data-native-list={Boolean(props.multiple || (props.size && props.size > 1)) || undefined}
  />;
}
