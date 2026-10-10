import type { ChangeEvent, RefObject } from "react";
import { ImagePlus, LoaderCircle, MapPin, Upload, ZoomIn } from "lucide-react";
import type { CtripLibraryImageCandidate, CtripLibraryPlaceCandidate, CtripLibraryPlaceSearchResult, CtripLibrarySearchResult } from "../../../../shared/contracts-types.js";
import { Select } from "../../helpers/Select";
import shared from "../shared.module.less";
import type { ImageLightboxItem } from "./image-lightbox";
import styles from "./review-summary-basic-info.module.less";

export function CoverSearchPanel(props: {
  fileInputRef: RefObject<HTMLInputElement | null>;
  allowedMime: readonly string[];
  maxFileSizeMib: number;
  uploading: boolean; saving: boolean; placeSearching: boolean; imageSearching: boolean;
  searchKeyword: string;
  placeResult: CtripLibraryPlaceSearchResult | null; placeError: string | null;
  selectedPlace: CtripLibraryPlaceCandidate | null;
  imageResult: CtripLibrarySearchResult | null; imageError: string | null;
  onUpload: (event: ChangeEvent<HTMLInputElement>) => void;
  onKeywordChange: (value: string) => void;
  onSearchPlaces: () => void;
  onPickPlace: (place: CtripLibraryPlaceCandidate) => void;
  onPickCandidate: (candidate: CtripLibraryImageCandidate) => void;
  onOpenImage: (items: ImageLightboxItem[], index: number) => void;
}) {
  const disabled = props.saving || props.uploading || props.placeSearching || props.imageSearching;
  return <>
    <div className={styles.coverToolbar} role="group" aria-label="封面操作工具条">
      <button type="button" className={`${shared.btn} ${shared.btnSm}`} data-variant="primary" disabled={disabled}
        onClick={() => props.fileInputRef.current?.click()} data-testid="cover-manual-pick">
        <Upload size={12} aria-hidden="true" /> {props.uploading ? "上传中…" : "选择图片并保存"}
      </button>
      <input ref={props.fileInputRef} type="file" accept={props.allowedMime.join(",")} data-testid="cover-manual-file"
        onChange={props.onUpload} disabled={props.uploading} style={{ display: "none" }} />
      <span className={styles.coverToolbarDivider} aria-hidden="true" />
      <input className={styles.input} type="text" value={props.searchKeyword}
        onChange={event => props.onKeywordChange(event.target.value)} placeholder="景点名称（如：云冈石窟、莫高窟）"
        aria-label="携程图库景点名称" disabled={props.placeSearching || props.imageSearching} data-testid="cover-search-keyword" />
      <button type="button" className={`${shared.btn} ${shared.btnSm}`} data-variant="secondary" disabled={disabled}
        onClick={props.onSearchPlaces} data-testid="cover-search-submit">
        {props.placeSearching ? <><LoaderCircle size={12} className={styles.spin} aria-hidden="true" /> 查询中…</>
          : <><MapPin size={12} aria-hidden="true" /> 查询地址</>}
      </button>
    </div>
    <span className={styles.hint}>支持 jpg/png/webp，单张最大 {props.maxFileSizeMib} MiB；图库查询分两阶段：先选地址，再选图片。</span>
    {props.placeSearching ? <span className={styles.hint} data-testid="cover-place-loading">查询地址中，请稍候…</span> : null}
    {props.placeError ? <span className={styles.hint} data-state="warn" data-testid="cover-place-error">{props.placeError}</span> : null}
    {props.placeResult?.places.length ? <CoverPlaces places={props.placeResult.places} selectedPlace={props.selectedPlace}
      disabled={props.imageSearching || props.saving} onPick={props.onPickPlace} /> : null}
    {props.imageSearching ? <span className={styles.hint} data-testid="cover-image-loading">查询图片中，请稍候…</span> : null}
    {props.imageError ? <span className={styles.hint} data-state="warn" data-testid="cover-image-error">{props.imageError}</span> : null}
    {props.imageResult?.candidates.length ? <CoverCandidates candidates={props.imageResult.candidates} onPick={props.onPickCandidate}
      saving={props.saving} onOpenImage={props.onOpenImage} /> : null}
  </>;
}

function CoverPlaces({ places, selectedPlace, disabled, onPick }: {
  places: CtripLibraryPlaceCandidate[]; selectedPlace: CtripLibraryPlaceCandidate | null;
  disabled: boolean; onPick: (place: CtripLibraryPlaceCandidate) => void;
}) {
  return <Select aria-label="携程图库地点候选" data-testid="cover-place-select" value={selectedPlace?.stableId ?? ""}
    disabled={disabled} onChange={event => { const place = places.find(item => item.stableId === event.target.value); if (place) onPick(place); }}>
    <option value="" disabled>请选择地点</option>
    {places.map(place => <option key={place.stableId} value={place.stableId}>{formatPlaceOption(place)}</option>)}
  </Select>;
}

function formatPlaceOption(place: CtripLibraryPlaceCandidate): string {
  const location = [place.province, place.city, place.district, place.address].filter((part): part is string => Boolean(part?.trim())).join(" · ");
  return location ? `${place.poiName}（${location}）` : place.poiName;
}

function CoverCandidates({ candidates, onPick, saving, onOpenImage }: {
  candidates: CtripLibraryImageCandidate[]; onPick: (candidate: CtripLibraryImageCandidate) => void;
  saving: boolean; onOpenImage: (items: ImageLightboxItem[], index: number) => void;
}) {
  return <ul className={styles.coverCandidates} aria-label="携程图库候选" data-testid="cover-search-candidates">
    {candidates.map(candidate => {
      const selectable = isCandidateSelectable(candidate);
      return <li key={candidate.stableId} className={styles.coverCandidate}>
        <CoverCandidateThumb candidate={candidate} onOpenImage={onOpenImage} />
        <div className={styles.coverCandidateMeta}><strong>imageId {candidate.imageId}</strong><span className={styles.hint}>
          {typeof candidate.imageId === "number" ? <>imageId <span className={styles.rowMetaMono}>{candidate.imageId}</span></> : null}
          {typeof candidate.score === "number" ? <> · 质量 {candidate.score.toFixed(1)}</> : null}
          {candidate.resolution ? <> · {candidate.resolution}</> : null}{candidate.poiName ? <> · {candidate.poiName}</> : null}
        </span></div>
        <button type="button" className={`${shared.btn} ${shared.btnSm}`} data-variant="secondary" disabled={!selectable || saving}
          onClick={() => onPick(candidate)} data-testid="cover-candidate-pick" aria-disabled={!selectable || saving}
          title={selectable ? undefined : "未取到图片：imageId / imageUrl 缺失"}>{selectable ? "使用" : "未取到图片"}</button>
      </li>;
    })}
  </ul>;
}

function CoverCandidateThumb({ candidate, onOpenImage }: { candidate: CtripLibraryImageCandidate; onOpenImage: (items: ImageLightboxItem[], index: number) => void }) {
  const src = candidate.imageUrl || candidate.previewUrl || candidate.thumbnailUrl;
  if (!src) return <div className={styles.coverCandidatePlaceholder} aria-hidden="true" data-testid="cover-candidate-placeholder"><ImagePlus size={14} /></div>;
  const alt = candidate.imageId ? `imageId ${candidate.imageId}` : "携程图库图片";
  return <div className={styles.coverCandidateThumbWrap}>
    <img className={styles.coverCandidateThumb} src={src} alt={alt} loading="lazy" />
    <div className={styles.imageZoomHoverLayer}><button type="button" className={`${shared.iconBtn} ${styles.imageZoomButton}`}
      onClick={() => onOpenImage([{ src, alt, title: alt, subtitle: "携程图库候选" }], 0)} aria-label={`放大查看 ${alt}`} title="放大查看">
      <ZoomIn size={16} aria-hidden="true" /><span className={styles.imageZoomText}>放大</span>
    </button></div>
  </div>;
}

export function isCandidateSelectable(candidate: CtripLibraryImageCandidate): boolean {
  return typeof candidate.imageId === "number" && Number.isInteger(candidate.imageId) && candidate.imageId > 0
    && typeof candidate.imageUrl === "string" && candidate.imageUrl.trim().length > 0;
}
