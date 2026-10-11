import { ChevronDown, LoaderCircle, RefreshCw } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import styles from "../vbk.module.less";
import menu from "./stage-retry-menu.module.less";

interface RetryOption {
  key: string;
  label: string;
  busy: boolean;
}

interface Props {
  sectionLabel: string;
  options: RetryOption[];
  disabled: boolean;
  disabledReason: string;
  onRetry: (phase: string) => void;
}

/** 多资源阶段的菜单挂到 body，避免被审查面板的滚动容器裁切。 */
export function StageRetryMenu({ sectionLabel, options, disabled, disabledReason, onRetry }: Props) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();
  const busy = options.some(option => option.busy);

  function close(restoreFocus = false) {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus({ preventScroll: true });
  }

  useLayoutEffect(() => {
    if (!open || !trigger.current || !panel.current) return;
    const anchor = trigger.current.getBoundingClientRect();
    const bounds = panel.current.getBoundingClientRect();
    setPosition({
      top: anchor.bottom + bounds.height + 8 <= window.innerHeight
        ? anchor.bottom + 4 : Math.max(8, anchor.top - bounds.height - 4),
      left: Math.max(8, Math.min(anchor.right - bounds.width, window.innerWidth - bounds.width - 8)),
    });
    const first = panel.current.querySelector<HTMLButtonElement>("button:not(:disabled)");
    (first ?? panel.current).focus({ preventScroll: true });
  }, [open, disabled]);

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!panel.current?.contains(target) && !trigger.current?.contains(target)) close();
    };
    const reposition = (event: Event) => {
      if (!panel.current?.contains(event.target as Node)) close();
    };
    document.addEventListener("pointerdown", dismiss);
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [open]);

  return <>
    <button
      ref={trigger}
      type="button"
      className={styles.stageAction}
      aria-label={`重新执行「${sectionLabel}」`}
      aria-haspopup="menu"
      aria-expanded={open}
      aria-controls={open ? id : undefined}
      data-busy={busy}
      onClick={() => setOpen(value => !value)}
      onKeyDown={event => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault(); setOpen(true);
        }
      }}
    >
      {busy ? <LoaderCircle size={12} className={styles.stageActionSpinner} /> : null}
      <span>{busy ? "执行中" : "重新执行"}</span><ChevronDown size={12} />
    </button>
    {open && createPortal(
      <div
        ref={panel}
        id={id}
        className={menu.panel}
        style={position}
        role="menu"
        aria-label={`${sectionLabel}重跑选项`}
        tabIndex={-1}
        onBlur={event => {
          if (!event.currentTarget.contains(event.relatedTarget) && event.relatedTarget !== trigger.current) close();
        }}
        onKeyDown={event => {
          if (event.key === "Escape") { event.preventDefault(); close(true); return; }
          const keys = ["ArrowDown", "ArrowUp", "Home", "End"];
          if (!keys.includes(event.key)) return;
          event.preventDefault();
          const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
          const current = items.indexOf(document.activeElement as HTMLButtonElement);
          const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
            : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
          items[next]?.focus({ preventScroll: true });
        }}
      >
        {options.map(option => <button
          key={option.key}
          type="button"
          role="menuitem"
          className={menu.item}
          disabled={disabled}
          aria-label={`重新执行「${sectionLabel}」的「${option.label}」`}
          title={disabled ? disabledReason : `仅重跑 ${option.label}，不影响其他阶段`}
          onClick={() => { close(true); onRetry(option.key); }}
        >
          {option.busy ? <LoaderCircle size={12} className={styles.stageActionSpinner} /> : <RefreshCw size={12} />}
          <span>{option.label}</span>
        </button>)}
        {disabled ? <small className={menu.reason}>{disabledReason}</small> : null}
      </div>, document.body,
    )}
  </>;
}
