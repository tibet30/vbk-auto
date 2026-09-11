/**
 * 通用图片放大查看 Lightbox（支持单图 + 多图轮播）。
 *
 * 能力（与基础信息封面行、图库候选共用）：
 *  - 滚轮缩放（1x ~ 5x，以图片中心为锚点），拖拽平移，双击在 1x / 2.5x 间切换；
 *  - 底部控制栏：缩放百分比 + 缩小 / 放大 / 适应窗口 / 重置；
 *  - 顶部标题栏：标题（如 POI）+ 副标题（如来源）+ 多图时的 "n / N" 计数，
 *    右侧关闭按钮；
 *  - 多图模式：stage 两侧左右切换按钮，键盘 ← / → 切图；
 *  - 关闭：ESC / 点击非图片区域（图片本体 stopPropagation，其余区域走
 *    overlay.onClose）；打开时锁定背景滚动，关闭后归还焦点；
 *  - 图片加载中显示 spinner；尊重 prefers-reduced-motion。
 *
 * 兼容性：
 *  - 单图模式（仅传 `image`）行为保持向后兼容，编辑态候选缩略图仍按单图打开；
 *  - 多图模式（同时传 `items` + `index` + `onIndexChange`）开启轮播能力，
 *    切图时自动重置 view（scale=1, x=0, y=0），避免上一张遗留的位移影响
 *    下一张的居中显示。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, WheelEvent as ReactWheelEvent } from "react";
import { ChevronLeft, ChevronRight, LoaderCircle, Maximize, Minus, Plus, RotateCcw, X } from "lucide-react";
import styles from "./image-lightbox.module.less";

export interface ImageLightboxItem {
  src: string;
  alt?: string;
  title?: string;
  subtitle?: string;
}

export interface ImageLightboxProps {
  /** 单图模式：直接传一张图。 */
  image: ImageLightboxItem | null;
  onClose: () => void;
  /** 多图模式：传入完整轮播列表。空数组/未传 = 退化为单图模式。 */
  items?: ImageLightboxItem[] | null;
  /** 多图模式受控索引。 */
  index?: number;
  /** 多图模式索引变更回调；用于驱动父组件同步选中状态。 */
  onIndexChange?: (next: number) => void;
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

interface DragState {
  pointerId: number;
  startX: number;
  startY: number;
  originX: number;
  originY: number;
  moved: boolean;
}

/**
 * 判断事件目标是否落在 <img> 本体上：点击图片正中间的"图片本体"不关闭，
 * 点击图片之外的任何区域（包括 stage 空白、header、footer、遮罩）
 * 都由 overlay.onClick 兜底关闭。
 */
function isImageElement(target: EventTarget | null): boolean {
  return target instanceof HTMLImageElement;
}

export function ImageLightbox({ image, onClose, items, index, onIndexChange }: ImageLightboxProps) {
  /** 多图模式：normalize 出当前轮播项 + 总数 + 受控索引。 */
  const carouselItems: ImageLightboxItem[] | null = Array.isArray(items) && items.length > 0
    ? items
    : null;
  const isCarousel = carouselItems !== null;
  const safeIndex = isCarousel
    ? Math.max(0, Math.min(index ?? 0, carouselItems.length - 1))
    : 0;
  const currentItem: ImageLightboxItem | null = isCarousel
    ? (carouselItems?.[safeIndex] ?? null)
    : image;

  const [view, setView] = useState<ViewState>({ scale: 1, x: 0, y: 0 });
  const [loading, setLoading] = useState(true);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);

  // 打开 / 切图时重置视图与加载态，避免上一张遗留 scale / translate。
  // 依赖 currentItem（同一图 src 变化时也复位，例如同一灯箱点开不同缩略图）。
  useEffect(() => {
    if (!currentItem) return;
    setView({ scale: 1, x: 0, y: 0 });
    setLoading(true);
  }, [currentItem?.src]);

  // 打开时：记录焦点、锁背景滚动、自动聚焦关闭按钮；关闭时清理并归还焦点。
  useEffect(() => {
    if (!currentItem) return;
    restoreFocusRef.current = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeButtonRef.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      restoreFocusRef.current?.focus?.();
    };
  }, [currentItem?.src]);

  // ESC 关闭；多图模式下 ← / → 切图。
  useEffect(() => {
    if (!currentItem) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (isCarousel && onIndexChange && carouselItems) {
        if (event.key === "ArrowLeft") {
          event.preventDefault();
          onIndexChange((safeIndex - 1 + carouselItems.length) % carouselItems.length);
        } else if (event.key === "ArrowRight") {
          event.preventDefault();
          onIndexChange((safeIndex + 1) % carouselItems.length);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [currentItem?.src, isCarousel, onClose, onIndexChange, safeIndex, carouselItems?.length]);

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

  const goPrev = useCallback(() => {
    if (!isCarousel || !onIndexChange || !carouselItems) return;
    onIndexChange((safeIndex - 1 + carouselItems.length) % carouselItems.length);
  }, [isCarousel, onIndexChange, carouselItems, safeIndex]);

  const goNext = useCallback(() => {
    if (!isCarousel || !onIndexChange || !carouselItems) return;
    onIndexChange((safeIndex + 1) % carouselItems.length);
  }, [isCarousel, onIndexChange, carouselItems, safeIndex]);

  if (!currentItem) return null;

  const zoomInDisabled = view.scale >= MAX_SCALE;
  const zoomOutDisabled = view.scale <= MIN_SCALE;
  const isZoomed = view.scale > MIN_SCALE || view.x !== 0 || view.y !== 0;
  const showArrows = isCarousel && (carouselItems?.length ?? 0) > 1;

  const onWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    zoomBy(event.deltaY < 0 ? STEP : -STEP);
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    // 仅在已放大时启用拖拽平移；缩放 = 1x 时不抢占 pointer 行为。
    if (view.scale <= MIN_SCALE) return;
    // 图片本体才接管拖拽，非图片区域（stage 空白）让 overlay 处理关闭。
    if (!isImageElement(event.target)) return;
    event.stopPropagation();
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
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

  const onDoubleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!isImageElement(event.target)) return;
    event.stopPropagation();
    if (view.scale > MIN_SCALE) reset();
    else zoomTo(DOUBLE_CLICK_SCALE);
  };

  // 图片本体 click 阻止冒泡 → 点击图片不触发 overlay 关闭。
  // 非图片区域的 click 由 overlay.onClick 兜底关闭。
  const stopOnImageClick = (event: React.MouseEvent<HTMLImageElement>) => {
    event.stopPropagation();
  };

  // 左右切换 / 缩放 / 关闭按钮：自己处理 + 阻止冒泡（它们是显式控件，
  // 不应该同时触发 overlay 的"点击非图片区域关闭"路径）。
  const stopBubble = (event: React.MouseEvent | ReactPointerEvent) => {
    event.stopPropagation();
  };

  return (
    <div
      className={styles.overlay}
      role="dialog"
      aria-modal="true"
      aria-label={currentItem.title || "放大查看图片"}
      onClick={onClose}
    >
      <div className={styles.header} onClick={stopBubble}>
        <div className={styles.headerText}>
          {currentItem.title ? <strong className={styles.title}>{currentItem.title}</strong> : null}
          {currentItem.subtitle ? <span className={styles.subtitle}>{currentItem.subtitle}</span> : null}
        </div>
        {isCarousel && carouselItems ? (
          <span className={styles.counter} aria-label={`当前 ${safeIndex + 1} 张，共 ${carouselItems.length} 张`}>
            {safeIndex + 1} / {carouselItems.length}
          </span>
        ) : null}
        <button
          ref={closeButtonRef}
          type="button"
          className={styles.closeButton}
          onClick={(event) => { stopBubble(event); onClose(); }}
          aria-label="关闭大图"
        >
          <X size={18} aria-hidden="true" />
        </button>
      </div>

      <div
        ref={stageRef}
        className={styles.stage}
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
        {showArrows ? (
          <>
            <button
              type="button"
              className={`${styles.navButton} ${styles.navButtonPrev}`}
              onClick={(event) => { stopBubble(event); goPrev(); }}
              aria-label="上一张"
              data-testid="lightbox-prev"
            >
              <ChevronLeft size={22} aria-hidden="true" />
            </button>
            <button
              type="button"
              className={`${styles.navButton} ${styles.navButtonNext}`}
              onClick={(event) => { stopBubble(event); goNext(); }}
              aria-label="下一张"
              data-testid="lightbox-next"
            >
              <ChevronRight size={22} aria-hidden="true" />
            </button>
          </>
        ) : null}
        <img
          className={styles.image}
          src={currentItem.src}
          alt={currentItem.alt || currentItem.title || "大图"}
          draggable={false}
          onClick={stopOnImageClick}
          onLoad={() => setLoading(false)}
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
        />
      </div>

      <div className={styles.footer} onClick={stopBubble}>
        <span className={styles.zoomLabel}>{Math.round(view.scale * 100)}%</span>
        <button
          type="button"
          className={styles.toolButton}
          onClick={(event) => { stopBubble(event); zoomBy(-STEP); }}
          disabled={zoomOutDisabled}
          aria-label="缩小"
        >
          <Minus size={16} aria-hidden="true" />
        </button>
        <button
          type="button"
          className={styles.toolButton}
          onClick={(event) => { stopBubble(event); zoomBy(STEP); }}
          disabled={zoomInDisabled}
          aria-label="放大"
        >
          <Plus size={16} aria-hidden="true" />
        </button>
        <span className={styles.divider} aria-hidden="true" />
        <button
          type="button"
          className={styles.toolButton}
          onClick={(event) => { stopBubble(event); zoomTo(MIN_SCALE); }}
          aria-label="适应窗口"
        >
          <Maximize size={16} aria-hidden="true" />
        </button>
        <button
          type="button"
          className={styles.toolButton}
          onClick={(event) => { stopBubble(event); reset(); }}
          disabled={!isZoomed}
          aria-label="重置缩放"
        >
          <RotateCcw size={16} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
