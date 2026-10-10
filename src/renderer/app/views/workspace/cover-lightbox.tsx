import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, ImagePlus, ZoomIn } from "lucide-react";
import type { ProductCover } from "../../../../shared/contracts-types.js";
import type { ImageLightboxItem } from "./image-lightbox";
import styles from "./review-summary-basic-info.module.less";

const MAX_COVER_IMAGES = 20;

function useCoverCarouselItems(cover: ProductCover, resolvedUrl: string | null): ImageLightboxItem[] {
  return useMemo(() => {
    if (cover.source === "manualUpload") return resolvedUrl ? [{
      src: resolvedUrl, alt: cover.poi || "封面预览", title: cover.poi || "封面预览", subtitle: "手动上传",
    }] : [];
    const items: ImageLightboxItem[] = [];
    if (cover.imageUrl) {
      const title = cover.poi || "封面";
      items.push({ src: cover.imageUrl, alt: title, title, subtitle: "携程图库 · 主封面" });
    }
    for (const alternate of cover.alternates?.slice(0, MAX_COVER_IMAGES - 1) ?? []) {
      if (!alternate.imageUrl) continue;
      const title = alternate.poi || alternate.poiName || `imageId ${alternate.imageId}`;
      items.push({ src: alternate.imageUrl, alt: title, title, subtitle: "携程图库 · 备用封面" });
    }
    return items;
  }, [cover, resolvedUrl]);
}

export function CoverDisplay({ cover, previewUrl, onReadPreviewUrl, onOpenImage }: {
  cover: ProductCover;
  previewUrl: string | null;
  onReadPreviewUrl: (fileId: string, originalName: string) => Promise<string | null>;
  onOpenImage: (items: ImageLightboxItem[], index: number) => void;
}) {
  const [resolvedUrl, setResolvedUrl] = useState<string | null>(previewUrl);
  const [currentIndex, setCurrentIndex] = useState(0);
  useEffect(() => setResolvedUrl(previewUrl), [previewUrl]);
  useEffect(() => {
    if (cover.source !== "manualUpload" || resolvedUrl) return;
    let cancelled = false;
    onReadPreviewUrl(cover.fileId, cover.originalName).then(url => {
      if (!cancelled) setResolvedUrl(url);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [cover, resolvedUrl, onReadPreviewUrl]);
  const items = useCoverCarouselItems(cover, resolvedUrl);
  useEffect(() => {
    if (currentIndex >= items.length) setCurrentIndex(Math.max(0, items.length - 1));
  }, [items, currentIndex]);
  if (items.length === 0) return <div className={styles.coverDisplay}>
    <div className={styles.coverPlaceholder} aria-hidden="true"><ImagePlus size={16} /></div>
    <div className={styles.coverMeta}><span className={styles.hint}>封面数据存在但图片 URL 缺失，请重新编辑。</span></div>
  </div>;

  const safeIndex = Math.min(currentIndex, items.length - 1);
  const current = items[safeIndex]!;
  const hasMultiple = items.length > 1;
  return <div className={styles.coverDisplay} data-testid="cover-display">
    <div className={styles.coverCarousel}>
      <button type="button" className={styles.coverThumbButton} onClick={() => onOpenImage(items, safeIndex)}
        aria-label={`放大查看封面：${current.alt || current.title}`} title="放大查看" data-testid="cover-open-lightbox">
        <img className={styles.coverThumb} src={current.src} alt={current.alt || current.title || "封面"} />
        {hasMultiple ? <span className={styles.coverCarouselCounter} aria-label={`当前 ${safeIndex + 1} 张，共 ${items.length} 张`}>
          {safeIndex + 1} / {items.length}
        </span> : null}
        <span className={styles.coverZoomHint} aria-hidden="true"><ZoomIn size={14} /><span>放大查看</span></span>
      </button>
      {hasMultiple ? <>
        <button type="button" className={`${styles.coverCarouselNav} ${styles.coverCarouselNavPrev}`}
          onClick={() => setCurrentIndex((safeIndex - 1 + items.length) % items.length)} aria-label="上一张封面" data-testid="cover-carousel-prev">
          <ChevronLeft size={16} aria-hidden="true" />
        </button>
        <button type="button" className={`${styles.coverCarouselNav} ${styles.coverCarouselNavNext}`}
          onClick={() => setCurrentIndex((safeIndex + 1) % items.length)} aria-label="下一张封面" data-testid="cover-carousel-next">
          <ChevronRight size={16} aria-hidden="true" />
        </button>
        <div className={styles.coverCarouselDots} role="tablist" aria-label="封面轮播指示器">
          {items.map((_, index) => <button type="button" key={index} className={styles.coverCarouselDot}
            data-active={index === safeIndex} aria-label={`切换到第 ${index + 1} 张`} aria-selected={index === safeIndex}
            role="tab" onClick={() => setCurrentIndex(index)} />)}
        </div>
      </> : null}
    </div>
    <div className={styles.coverMeta}>
      <div className={styles.rowDisplay}>
        <strong>{cover.source === "manualUpload" ? cover.poi || "封面预览" : cover.poi}</strong>
        <span className={styles.tag} data-tone={cover.source === "manualUpload" ? "warn" : "ok"}>
          {cover.source === "manualUpload" ? "手动上传" : "携程图库"}
        </span>
        {cover.source === "manualUpload" && typeof cover.minQuality === "number" ? <span className={styles.tag}>质量 ≥ {cover.minQuality}</span> : null}
      </div>
      {cover.source === "ctripLibrary" ? <CtripCoverMeta cover={cover} index={safeIndex} /> : <span className={styles.hint}>
        文件：{cover.originalName} · {(cover.sizeBytes / 1024).toFixed(1)} KiB · 上传于 {formatTimestamp(cover.uploadedAt)}
        {resolvedUrl ? null : " · 本地副本已失效，请重新上传"}
      </span>}
    </div>
  </div>;
}

function CtripCoverMeta({ cover, index }: { cover: Extract<ProductCover, { source: "ctripLibrary" }>; index: number }) {
  const alternate = index > 0 ? cover.alternates?.[index - 1] : undefined;
  const imageId = alternate?.imageId ?? cover.imageId;
  const score = alternate?.score ?? cover.score;
  const resolution = alternate?.resolution ?? cover.resolution;
  return <span className={styles.hint}>
    imageId <span className={styles.rowMetaMono}>{imageId}</span>
    {typeof score === "number" ? <> · 质量分 {score.toFixed(1)}</> : null}
    {resolution ? <> · {resolution}</> : null}{alternate ? <> · 备用封面</> : null}
  </span>;
}

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
