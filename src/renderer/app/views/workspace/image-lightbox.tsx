/**
 * 通用图片放大查看 Lightbox。
 *
 * 能力（与基础信息封面行、图库候选共用）：
 *  - 滚轮缩放（1x ~ 5x，以图片中心为锚点），拖拽平移，双击在 1x / 2.5x 间切换；
 *  - 底部控制栏：缩放百分比 + 缩小 / 放大 / 适应窗口 / 重置；
 *  - 顶部标题栏：标题（如 POI）+ 副标题（如来源），右侧关闭按钮；
 *  - ESC / 点击遮罩关闭；打开时锁定背景滚动，关闭后归还焦点；
 *  - 图片加载中显示 spinner；尊重 prefers-reduced-motion。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, WheelEvent as ReactWheelEvent } from "react";
import { LoaderCircle, Maximize, Minus, Plus, RotateCcw, X } from "lucide-react";
import styles from "./image-lightbox.module.less";

export interface ImageLightboxItem {
  src: string;
  alt?: string;
  title?: string;
  subtitle?: string;
}

export interface ImageLightboxProps {
  image: ImageLightboxItem | null;
  onClose: () => void;
}

const MIN_SCALE = 1;
const MAX_SCALE = 5;
const STEP = 0.5;
const DOUBLE_CLICK_SCALE = 2.5;

function clampScale(value: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, value));
}

interface ViewState {
  scale: number;
  x: number;
  y: number;
}

export function ImageLightbox({ image, onClose }: ImageLightboxProps) {
  const [view, setView] = useState<ViewState>({ scale: 1, x: 0, y: 0 });
  const [loading, setLoading] = useState(true);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
    moved: boolean;
  } | null>(null);

  // 打开时：记录焦点、锁背景滚动、重置视图与加载态；关闭时清理并归还焦点。
  useEffect(() => {
    if (!image) return;
    restoreFocusRef.current = document.activeElement as HTMLElement | null;
    setView({ scale: 1, x: 0, y: 0 });
    setLoading(true);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeButtonRef.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      restoreFocusRef.current?.focus?.();
    };
  }, [image]);

  // ESC 关闭。
  useEffect(() => {
    if (!image) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [image, onClose]);

  const reset = useCallback(() => setView({ scale: 1, x: 0, y: 0 }), []);

  const zoomBy = useCallback((factor: number) => {
    setView((current) => {
      const scale = clampScale(current.scale + factor);
      // 缩回 1x 时一并归零平移，避免图片偏离原位。
      return scale <= MIN_SCALE ? { scale, x: 0, y: 0 } : { ...current, scale };
    });
  }, []);

  const zoomTo = useCallback((scale: number) => {
    const next = clampScale(scale);
    setView(next <= MIN_SCALE ? { scale: next, x: 0, y: 0 } : (current) => ({ ...current, scale: next }));
  }, []);

  if (!image) return null;

  const zoomInDisabled = view.scale >= MAX_SCALE;
  const zoomOutDisabled = view.scale <= MIN_SCALE;
  const isZoomed = view.scale > MIN_SCALE || view.x !== 0 || view.y !== 0;

  const onWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    zoomBy(event.deltaY < 0 ? STEP : -STEP);
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (view.scale <= MIN_SCALE) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: view.x,
      originY: view.y,
      moved: false,
    };
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (Math.abs(dx) + Math.abs(dy) > 2) drag.moved = true;
    setView((current) => ({ ...current, x: drag.originX + dx, y: drag.originY + dy }));
  };

  const onPointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
  };

  const onDoubleClick = () => {
    if (view.scale > MIN_SCALE) reset();
    else zoomTo(DOUBLE_CLICK_SCALE);
  };

  return (
    <div
      className={styles.overlay}
      role="dialog"
      aria-modal="true"
      aria-label={image.title || "放大查看图片"}
      onClick={onClose}
    >
      <div className={styles.header} onClick={(event) => event.stopPropagation()}>
        <div className={styles.headerText}>
          {image.title ? <strong className={styles.title}>{image.title}</strong> : null}
          {image.subtitle ? <span className={styles.subtitle}>{image.subtitle}</span> : null}
        </div>
        <button
          ref={closeButtonRef}
          type="button"
          className={styles.closeButton}
          onClick={onClose}
          aria-label="关闭大图"
        >
          <X size={18} aria-hidden="true" />
        </button>
      </div>

      <div
        className={styles.stage}
        onClick={(event) => event.stopPropagation()}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onDoubleClick={onDoubleClick}
      >
        {loading ? (
          <span className={styles.loading} aria-label="图片加载中">
            <LoaderCircle size={22} className={styles.spin} aria-hidden="true" />
          </span>
        ) : null}
        <img
          className={styles.image}
          src={image.src}
          alt={image.alt || image.title || "大图"}
          draggable={false}
          onLoad={() => setLoading(false)}
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
        />
      </div>

      <div className={styles.footer} onClick={(event) => event.stopPropagation()}>
        <span className={styles.zoomLabel}>{Math.round(view.scale * 100)}%</span>
        <button type="button" className={styles.toolButton} onClick={() => zoomBy(-STEP)} disabled={zoomOutDisabled} aria-label="缩小">
          <Minus size={16} aria-hidden="true" />
        </button>
        <button type="button" className={styles.toolButton} onClick={() => zoomBy(STEP)} disabled={zoomInDisabled} aria-label="放大">
          <Plus size={16} aria-hidden="true" />
        </button>
        <span className={styles.divider} aria-hidden="true" />
        <button type="button" className={styles.toolButton} onClick={() => zoomTo(MIN_SCALE)} aria-label="适应窗口">
          <Maximize size={16} aria-hidden="true" />
        </button>
        <button type="button" className={styles.toolButton} onClick={reset} disabled={!isZoomed} aria-label="重置缩放">
          <RotateCcw size={16} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
