import {
  ArrowRight,
  Check,
  CircleSlash,
  CircleStop,
  Eye,
  Keyboard,
  ListFilter,
  LoaderCircle,
  Mouse,
  PenLine,
  Upload,
} from "lucide-react";
import type { OperationType } from "../../../../shared/contracts.js";
import styles from "./OperationTypeIcon.module.less";

/**
 * 操作类型图标。把每种自动化动作抽象为一个有视觉区分度的小图形，
 * 让运营在 30px 高度内就能识别当前是点击、输入还是导航，不再依赖
 * 翻译中文「自动点击」这种容易跟品牌混在一起的描述。
 */
export function OperationTypeIcon({ type, state }: { type: OperationType; state: "ok" | "fail" | "skip" | "run" | "neutral" }) {
  const Icon =
    type === "click"
      ? Mouse
      : type === "input"
        ? PenLine
        : type === "navigate"
          ? ArrowRight
          : type === "verify"
            ? Check
            : type === "screenshot"
              ? Eye
              : type === "wait"
                ? LoaderCircle
                : type === "select"
                  ? ListFilter
                  : type === "upload"
                    ? Upload
                    : Keyboard;

  if (state === "fail") {
    return (
      <span className={styles.opTypeIcon} data-state="fail" aria-hidden="true">
        <Icon size={14} />
      </span>
    );
  }
  if (state === "skip") {
    return (
      <span className={styles.opTypeIcon} data-state="skip" aria-hidden="true">
        <CircleSlash size={14} />
      </span>
    );
  }
  if (state === "run") {
    return (
      <span className={styles.opTypeIcon} data-state="run" aria-hidden="true">
        <LoaderCircle size={14} />
      </span>
    );
  }
  if (state === "ok") {
    return (
      <span className={styles.opTypeIcon} data-state="ok" aria-hidden="true">
        <Icon size={14} />
      </span>
    );
  }
  return (
    <span className={styles.opTypeIcon} data-state="neutral" aria-hidden="true">
      <CircleStop size={14} />
    </span>
  );
}

export const OPERATION_TYPE_LABEL: Record<OperationType, string> = {
  runtime: "运行输出",
  click: "点击",
  input: "输入",
  navigate: "导航",
  verify: "校验",
  screenshot: "截图",
  wait: "等待",
  select: "选择",
  upload: "上传",
};
