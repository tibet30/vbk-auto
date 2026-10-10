import { useCallback, useEffect, useRef, useState } from "react";
import { ImagePlus, LoaderCircle, Pencil, X } from "lucide-react";
import type {
  CtripLibraryImageCandidate,
  CtripLibraryPlaceCandidate,
  CtripLibraryPlaceSearchResult,
  CtripLibrarySearchResult,
  ManualUploadCoverMeta,
  ProductCover,
} from "../../../../shared/contracts-types.js";
import type { CoverFallback } from "../../../../shared/cover-fallback.js";
import coverFallbackImage from "../../../assets/cover-fallback.png";
import shared from "../shared.module.less";
import { BasicInfoRowShell } from "./basic-info-row-shell";
import { CoverDisplay } from "./cover-lightbox";
import { CoverSearchPanel, isCandidateSelectable } from "./cover-search";
import { ImageLightbox, type ImageLightboxItem } from "./image-lightbox";
import styles from "./review-summary-basic-info.module.less";

export interface BasicInfoCoverRowProps {
  cover: ProductCover | null;
  fallback: CoverFallback | null;
  /** Manual previews are data URLs (`data:${mime};base64,...`), never local file URLs. */
  previewUrl: string | null;
  saving: boolean;
  error: string | undefined;
  onClearError: () => void;
  onUploadManual: (args: { file: { name: string; type: string; base64: string } }) => Promise<ManualUploadCoverMeta | null>;
  onPickCtripLibrary: (args: { candidate: CtripLibraryImageCandidate }) => Promise<boolean>;
  onSearchCtripLibraryPlaces: (args: { keyword: string }) => Promise<CtripLibraryPlaceSearchResult | null>;
  onSearchCtripLibraryImages: (args: { keyword: string; place: CtripLibraryPlaceCandidate }) => Promise<CtripLibrarySearchResult | null>;
  onReadPreviewUrl: (fileId: string, originalName: string) => Promise<string | null>;
}

const ALLOWED_MIME = ["image/jpeg", "image/png", "image/webp"] as const;
const MAX_FILE_SIZE_BYTES = 8 * 1024 * 1024;
const MAX_FILE_SIZE_MIB = MAX_FILE_SIZE_BYTES / 1024 / 1024;

export function BasicInfoCoverRow(props: BasicInfoCoverRowProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [searchKeyword, setSearchKeyword] = useState("");
  const [placeResult, setPlaceResult] = useState<CtripLibraryPlaceSearchResult | null>(null);
  const [placeError, setPlaceError] = useState<string | null>(null);
  const [placeSearching, setPlaceSearching] = useState(false);
  const [selectedPlace, setSelectedPlace] = useState<CtripLibraryPlaceCandidate | null>(null);
  const [imageResult, setImageResult] = useState<CtripLibrarySearchResult | null>(null);
  const [imageError, setImageError] = useState<string | null>(null);
  const [imageSearching, setImageSearching] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [zoomTarget, setZoomTarget] = useState<{ item: ImageLightboxItem; items: ImageLightboxItem[]; index: number } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const submittedRef = useRef(false);
  const placeSearchInFlightRef = useRef(false);
  const imageSearchInFlightRef = useRef(false);

  const resetSearch = useCallback(() => {
    setPlaceResult(null); setPlaceError(null); setSelectedPlace(null); setImageResult(null); setImageError(null);
  }, []);

  useEffect(() => {
    if (!isEditing || !submittedRef.current || props.saving || uploading || placeSearching || imageSearching || props.error) return;
    setIsEditing(false);
    submittedRef.current = false;
    resetSearch();
  }, [isEditing, props.saving, uploading, placeSearching, imageSearching, props.error, resetSearch]);

  const startEdit = () => {
    submittedRef.current = false;
    props.onClearError();
    resetSearch();
    setIsEditing(true);
  };
  const cancel = () => {
    submittedRef.current = false;
    props.onClearError();
    resetSearch();
    setIsEditing(false);
  };

  const handleUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (fileInputRef.current) fileInputRef.current.value = "";
    if (!file) return;
    if (!ALLOWED_MIME.includes(file.type as (typeof ALLOWED_MIME)[number])) {
      props.onClearError();
      alert(`仅支持 ${ALLOWED_MIME.join("、")} 格式；当前：${file.type || "未知"}`);
      return;
    }
    if (file.size > MAX_FILE_SIZE_BYTES) {
      alert(`单张封面最大 ${MAX_FILE_SIZE_MIB} MiB；当前 ${(file.size / 1024 / 1024).toFixed(2)} MiB。`);
      return;
    }
    setUploading(true);
    submittedRef.current = true;
    try {
      await props.onUploadManual({ file: { name: file.name, type: file.type, base64: await readAsBase64(file) } });
    } finally {
      setUploading(false);
    }
  };

  const handleSearchPlaces = async () => {
    if (placeSearchInFlightRef.current || imageSearchInFlightRef.current || props.saving || uploading) return;
    const keyword = searchKeyword.trim();
    if (!keyword) {
      setPlaceError("请输入景点名称后再查询地址。");
      setPlaceResult(null);
      return;
    }
    placeSearchInFlightRef.current = true;
    setPlaceSearching(true);
    setPlaceError(null); setSelectedPlace(null); setImageResult(null); setImageError(null);
    try {
      const result = await props.onSearchCtripLibraryPlaces({ keyword });
      setPlaceResult(result);
      if (!result) setPlaceError("查询地址失败，请检查登录或稍后重试。");
      else if (result.places.length === 0) setPlaceError("未找到匹配的地址，请换一个景点名称。");
    } catch (error) {
      setPlaceResult(null);
      setPlaceError(error instanceof Error ? error.message : "查询地址失败，请重试。");
    } finally {
      placeSearchInFlightRef.current = false;
      setPlaceSearching(false);
    }
  };

  const handlePickPlace = async (place: CtripLibraryPlaceCandidate) => {
    if (imageSearchInFlightRef.current || props.saving || uploading) return;
    setSelectedPlace(place); setImageResult(null); setImageError(null);
    imageSearchInFlightRef.current = true;
    setImageSearching(true);
    try {
      const result = await props.onSearchCtripLibraryImages({ keyword: searchKeyword.trim(), place });
      setImageResult(result);
      if (!result) setImageError("查询图片失败，请检查登录或稍后重试。");
      else if (result.candidates.length === 0) setImageError("未取到图片，请换一个景点名称或确认携程图库是否有图。");
    } catch (error) {
      setImageError(error instanceof Error ? error.message : "查询图片失败，请重试。");
    } finally {
      imageSearchInFlightRef.current = false;
      setImageSearching(false);
    }
  };

  const handlePickCandidate = async (candidate: CtripLibraryImageCandidate) => {
    if (!isCandidateSelectable(candidate)) return;
    submittedRef.current = true;
    if (!await props.onPickCtripLibrary({ candidate })) submittedRef.current = false;
  };

  const openImageZoom = useCallback((items: ImageLightboxItem[], index: number) => {
    const item = items[index] ?? items[0];
    if (item) setZoomTarget({ item, items, index });
  }, []);
  const updateZoomIndex = useCallback((index: number) => setZoomTarget(current => {
    const item = current?.items[index] ?? current?.items[0];
    return current && item ? { item, items: current.items, index } : current;
  }), []);

  const lightbox = <ImageLightbox image={zoomTarget?.item ?? null} items={zoomTarget?.items} index={zoomTarget?.index}
    onIndexChange={updateZoomIndex} onClose={() => setZoomTarget(null)} />;

  if (!isEditing) return <>
    <BasicInfoRowShell rowId="cover" labelTitle="产品封面" actions={<button type="button"
      className={`${shared.btn} ${shared.btnSm}`} data-variant="ghost" onClick={startEdit}
      aria-label={props.cover || props.fallback ? "替换产品封面" : "添加产品封面"} disabled={props.saving}>
      <Pencil size={12} aria-hidden="true" /> {props.fallback && !props.cover ? "替换" : props.cover ? "编辑" : "添加"}
    </button>}>
      {props.cover ? <>
        <CoverDisplay cover={props.cover} previewUrl={props.previewUrl} onReadPreviewUrl={props.onReadPreviewUrl} onOpenImage={openImageZoom} />
        {props.cover.source === "ctripLibrary" && props.cover.missingPoiImages?.length
          ? <span className={styles.hint} data-tone="warn">待补景点图片：{props.cover.missingPoiImages.join("、")}。可按需补充，不影响确认和录入。</span> : null}
      </> : props.fallback ? <CoverFallbackDisplay fallback={props.fallback} /> : <div className={styles.rowDisplay} data-state="empty">
        <ImagePlus size={12} aria-hidden="true" /><strong>尚未设置封面</strong><span className={styles.hint}>手动上传图片或输入景点名称查询候选</span>
      </div>}
    </BasicInfoRowShell>
    {lightbox}
  </>;

  const busy = props.saving || uploading || placeSearching || imageSearching;
  return <>
    <BasicInfoRowShell rowId="cover" labelTitle="产品封面" error={props.error} className={styles.coverEditRow}
      actions={<>{busy ? <LoaderCircle size={12} className={styles.spin} aria-label="保存中" /> : null}
        <button type="button" className={`${shared.btn} ${shared.btnSm}`} onClick={cancel} disabled={busy} aria-label="取消编辑封面">
          <X size={12} aria-hidden="true" /> 取消
        </button></>}>
      <CoverSearchPanel fileInputRef={fileInputRef} allowedMime={ALLOWED_MIME} maxFileSizeMib={MAX_FILE_SIZE_MIB}
        uploading={uploading} saving={props.saving} placeSearching={placeSearching} imageSearching={imageSearching}
        searchKeyword={searchKeyword} placeResult={placeResult} placeError={placeError} selectedPlace={selectedPlace}
        imageResult={imageResult} imageError={imageError} onUpload={event => { void handleUpload(event); }}
        onKeywordChange={value => { setSearchKeyword(value); resetSearch(); }} onSearchPlaces={() => { void handleSearchPlaces(); }}
        onPickPlace={place => { void handlePickPlace(place); }} onPickCandidate={candidate => { void handlePickCandidate(candidate); }}
        onOpenImage={openImageZoom} />
    </BasicInfoRowShell>
    {lightbox}
  </>;
}

function CoverFallbackDisplay({ fallback }: { fallback: CoverFallback }) {
  return <div className={styles.coverFallbackDisplay} data-testid="cover-fallback-display">
    <img className={styles.coverFallbackImage} src={coverFallbackImage} alt="运营占位图：请替换为真实图片，仅供草稿录入，禁止上架" />
    <div className={styles.coverMeta}><strong>待替换真实封面</strong><span className={styles.tag} data-tone="warn">运营占位 · 禁止上架</span>
      <span className={styles.hint}>{fallback.reason === "search_unavailable" ? "图库暂不可用，请重试找图或手动上传。" : "行程景点未找到合格图片，请上传真实图片或从图库选择。"}</span>
      <span className={styles.hint}>占位图 1586 × 992，可上传 VBK 保存未提审草稿；上架前必须换图。</span>
    </div>
  </div>;
}

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== "string") return reject(new Error("无法读取文件内容。"));
      const comma = reader.result.indexOf(",");
      resolve(comma >= 0 ? reader.result.slice(comma + 1) : reader.result);
    };
    reader.onerror = () => reject(reader.error ?? new Error("读取文件失败。"));
    reader.readAsDataURL(file);
  });
}
