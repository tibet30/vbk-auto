/**
 * 「产品封面」行：presentation.cover
 *
 * 数据来源（discriminated union）：
 *  - ctripLibrary：imageId / imageUrl 必填，附带 poi / description / minQuality
 *    与可选 thumbnailUrl / previewUrl / score / resolution / poiId /
 *    poiName / selectedAt；
 *  - manualUpload：除上述字段外，还有 fileId / originalName / mimeType /
 *    sizeBytes / uploadedAt。
 *
 * 交互入口（两阶段，地址先行）：
 *  - 阶段 A：用户输入景点名称 → 点击「查询地址」→
 *    onSearchCtripLibraryPlaces({keyword}) → 渲染 places 列表；
 *  - 阶段 B：在 places 列表里选中一项 →
 *    onSearchCtripLibraryImages({keyword, place}) → 渲染 image candidates；
 *  - imageId + imageUrl 缺失的候选 use 按钮 disabled 并标"未取到图片"，
 *    避免写入空 cover；
 *  - 候选列表仍然限定固定高度并内部滚动，避免拉高 review 卡。
 *
 * 行为约束：
 *  - 默认展示态：cover 已存在时显示来源 chip + poi + 描述 + 质量分 + 关键元
 *    数据（imageId / 文件名 / sizeBytes 等）；无 cover 时显示入口；
 *  - 编辑态：紧凑工具条 + 阶段 A 候选 + 阶段 B 候选；不引入 max-height 影响
 *    review 主体；
 *  - 与其它基础信息行共用 rowDisplay / hint / tag 样式。
 */
import { useEffect, useRef, useState } from "react";
import {
  ImagePlus,
  LoaderCircle,
  MapPin,
  Pencil,
  Upload,
  X,
} from "lucide-react";
import type {
  CtripLibraryImageCandidate,
  CtripLibraryPlaceCandidate,
  CtripLibraryPlaceSearchResult,
  CtripLibrarySearchResult,
  ManualUploadCoverMeta,
  ProductCover,
} from "../../../../shared/contracts-types.js";
import shared from "../shared.module.less";
import { BasicInfoRowShell } from "./basic-info-row-shell";
import styles from "./review-summary-basic-info.module.less";

export interface BasicInfoCoverRowProps {
  /** product.presentation.cover 的快照；null = 还没有封面。 */
  cover: ProductCover | null;
  /** 渲染手动上传图片用的 data URL（data:${mime};base64,...）；renderer 通过 cover.read 取得。
   *  旧实现是走本地文件路径（渲染依赖文件系统路径），新版统一走 data URL，避免
   *  Electron 沙盒 / 路径编码下破图。 */
  previewUrl: string | null;
  /** 当前正在保存的字段名（cover）；UI 用来禁用按钮与显示 loading。 */
  saving: boolean;
  /** 错误文案（来自父组件的 errors.cover）。 */
  error: string | undefined;
  /** 清错（输入时调用）。 */
  onClearError: () => void;
  /**
   * 手动上传：只传 file 文件本身；POI / 描述 / 最低质量分由 action 层根据
   * 旧 cover / product basicInfo / 文件名 自动推导，不让 UI 增加负担。
   */
  onUploadManual: (args: { file: { name: string; type: string; base64: string } }) => Promise<ManualUploadCoverMeta | null>;
  /** 携程图库候选写入 product（ctripLibrary 形态）。 */
  onPickCtripLibrary: (args: { candidate: CtripLibraryImageCandidate }) => Promise<boolean>;
  /** 阶段 A：按景点名称解析 suggestpoi.json → places 候选列表。 */
  onSearchCtripLibraryPlaces: (args: { keyword: string }) => Promise<CtripLibraryPlaceSearchResult | null>;
  /**
   * 阶段 B：按已选 place 拉该地址下的图库图片列表。
   */
  onSearchCtripLibraryImages: (args: { keyword: string; place: CtripLibraryPlaceCandidate }) => Promise<CtripLibrarySearchResult | null>;
  /** 读取手动上传图片的 data URL（异步）；直接作为图片预览地址使用，文件不存在时返回 null。 */
  onReadPreviewUrl: (fileId: string, originalName: string) => Promise<string | null>;
}

const ALLOWED_MIME = ["image/jpeg", "image/png", "image/webp"] as const;
const MAX_FILE_SIZE_BYTES = 8 * 1024 * 1024;
const MAX_FILE_SIZE_MIB = Math.floor(MAX_FILE_SIZE_BYTES / 1024 / 1024);

export function BasicInfoCoverRow({
  cover,
  previewUrl,
  saving,
  error,
  onClearError,
  onUploadManual,
  onPickCtripLibrary,
  onSearchCtripLibraryPlaces,
  onSearchCtripLibraryImages,
  onReadPreviewUrl,
}: BasicInfoCoverRowProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [searchKeyword, setSearchKeyword] = useState("");
  /** 阶段 A 结果。 */
  const [placeResult, setPlaceResult] = useState<CtripLibraryPlaceSearchResult | null>(null);
  const [placeError, setPlaceError] = useState<string | null>(null);
  const [placeSearching, setPlaceSearching] = useState(false);
  /** 用户在 places 列表里选中的 place；选定后立刻触发阶段 B。 */
  const [selectedPlace, setSelectedPlace] = useState<CtripLibraryPlaceCandidate | null>(null);
  /** 阶段 B 结果。 */
  const [imageResult, setImageResult] = useState<CtripLibrarySearchResult | null>(null);
  const [imageError, setImageError] = useState<string | null>(null);
  const [imageSearching, setImageSearching] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const submittedRef = useRef(false);
  // React state 要等下一次渲染才会禁用控件；用 ref 补住双击/回车连发窗口。
  const placeSearchInFlightRef = useRef(false);
  const imageSearchInFlightRef = useRef(false);

  // 持久化回流：保存成功后退出编辑态。
  useEffect(() => {
    if (!isEditing) return;
    if (!submittedRef.current) return;
    if (saving || uploading || placeSearching || imageSearching) return;
    if (error) return;
    setIsEditing(false);
    submittedRef.current = false;
    setPlaceResult(null);
    setPlaceError(null);
    setSelectedPlace(null);
    setImageResult(null);
    setImageError(null);
  }, [isEditing, saving, uploading, placeSearching, imageSearching, error]);

  const startEdit = () => {
    submittedRef.current = false;
    onClearError();
    setIsEditing(true);
    setPlaceResult(null);
    setPlaceError(null);
    setSelectedPlace(null);
    setImageResult(null);
    setImageError(null);
  };
  const cancel = () => {
    submittedRef.current = false;
    onClearError();
    setIsEditing(false);
    setPlaceResult(null);
    setPlaceError(null);
    setSelectedPlace(null);
    setImageResult(null);
    setImageError(null);
  };

  const handleUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (fileInputRef.current) fileInputRef.current.value = "";
    if (!file) return;
    if (!ALLOWED_MIME.includes(file.type as (typeof ALLOWED_MIME)[number])) {
      onClearError();
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
      const base64 = await readAsBase64(file);
      await onUploadManual({
        file: { name: file.name, type: file.type, base64 },
      });
    } finally {
      setUploading(false);
    }
  };

  /** 阶段 A：按景点名称（keyword）查 places 候选列表。 */
  const handleSearchPlaces = async () => {
    if (placeSearchInFlightRef.current || imageSearchInFlightRef.current || saving || uploading) return;
    const keyword = searchKeyword.trim();
    if (keyword.length === 0) {
      setPlaceError("请输入景点名称后再查询地址。");
      setPlaceResult(null);
      return;
    }
    placeSearchInFlightRef.current = true;
    setPlaceSearching(true);
    setPlaceError(null);
    // 进入阶段 A 时清掉阶段 B 状态，避免旧 place / 旧 image candidates 残留。
    setSelectedPlace(null);
    setImageResult(null);
    setImageError(null);
    try {
      const result = await onSearchCtripLibraryPlaces({ keyword });
      if (!result) {
        setPlaceResult(null);
        setPlaceError("查询地址失败，请检查登录或稍后重试。");
        return;
      }
      setPlaceResult(result);
      if (result.places.length === 0) {
        setPlaceError("未找到匹配的地址，请换一个景点名称。");
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "查询地址失败，请重试。";
      setPlaceResult(null);
      setPlaceError(message);
    } finally {
      placeSearchInFlightRef.current = false;
      setPlaceSearching(false);
    }
  };

  /** 阶段 B：在 places 列表里选中一项 → 自动拉该 place 的图库图片。 */
  const handlePickPlace = async (place: CtripLibraryPlaceCandidate) => {
    if (imageSearchInFlightRef.current || saving || uploading) return;
    setSelectedPlace(place);
    setImageResult(null);
    setImageError(null);
    imageSearchInFlightRef.current = true;
    setImageSearching(true);
    const keyword = searchKeyword.trim();
    try {
      const result = await onSearchCtripLibraryImages({ keyword, place });
      if (!result) {
        setImageError("查询图片失败，请检查登录或稍后重试。");
        return;
      }
      setImageResult(result);
      if (result.candidates.length === 0) {
        setImageError("未取到图片，请换一个景点名称或确认携程图库是否有图。");
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "查询图片失败，请重试。";
      setImageError(message);
    } finally {
      imageSearchInFlightRef.current = false;
      setImageSearching(false);
    }
  };

  const handlePickCandidate = async (candidate: CtripLibraryImageCandidate) => {
    if (!isCandidateSelectable(candidate)) return;
    submittedRef.current = true;
    const ok = await onPickCtripLibrary({ candidate });
    if (!ok) submittedRef.current = false;
  };

  if (!isEditing) {
    return (
      <BasicInfoRowShell
        rowId="cover"
        labelTitle="产品封面"
        actions={
          <button
            type="button"
            className={`${shared.btn} ${shared.btnSm}`}
            data-variant="ghost"
            onClick={startEdit}
            aria-label={cover ? "编辑产品封面" : "添加产品封面"}
            disabled={saving}
          >
            <Pencil size={12} aria-hidden="true" /> {cover ? "编辑" : "添加"}
          </button>
        }
      >
        {cover ? (
          <CoverDisplay cover={cover} previewUrl={previewUrl} onReadPreviewUrl={onReadPreviewUrl} />
        ) : (
          <div className={styles.rowDisplay} data-state="empty">
            <ImagePlus size={12} aria-hidden="true" />
            <strong>尚未设置封面</strong>
            <span className={styles.hint}>手动上传图片或输入景点名称查询候选</span>
          </div>
        )}
      </BasicInfoRowShell>
    );
  }

  return (
    <BasicInfoRowShell
      rowId="cover"
      labelTitle="产品封面"
      error={error}
      actions={
        <>
          {saving || uploading || placeSearching || imageSearching ? <LoaderCircle size={12} className={styles.spin} aria-label="保存中" /> : null}
          <button
            type="button"
            className={`${shared.btn} ${shared.btnSm}`}
            onClick={cancel}
            disabled={saving || uploading || placeSearching || imageSearching}
            aria-label="取消编辑封面"
          >
            <X size={12} aria-hidden="true" /> 取消
          </button>
        </>
      }
    >
      <div className={styles.coverToolbar} role="group" aria-label="封面操作工具条">
        <button
          type="button"
          className={`${shared.btn} ${shared.btnSm}`}
          data-variant="primary"
          disabled={saving || uploading || placeSearching || imageSearching}
          onClick={() => fileInputRef.current?.click()}
          data-testid="cover-manual-pick"
        >
          <Upload size={12} aria-hidden="true" /> {uploading ? "上传中…" : "选择图片并保存"}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept={ALLOWED_MIME.join(",")}
          data-testid="cover-manual-file"
          onChange={(event) => { void handleUpload(event); }}
          disabled={uploading}
          style={{ display: "none" }}
        />
        <span className={styles.coverToolbarDivider} aria-hidden="true" />
        <input
          className={styles.input}
          type="text"
          value={searchKeyword}
          onChange={(event) => {
            setPlaceError(null);
            setImageError(null);
            setSearchKeyword(event.target.value);
            // 关键词变化后，旧地址和图片不再对应当前查询，立即清空。
            setPlaceResult(null);
            setSelectedPlace(null);
            setImageResult(null);
          }}
          placeholder="景点名称（如：云冈石窟、莫高窟）"
          aria-label="携程图库景点名称"
          disabled={placeSearching || imageSearching}
          data-testid="cover-search-keyword"
        />
        <button
          type="button"
          className={`${shared.btn} ${shared.btnSm}`}
          data-variant="secondary"
          disabled={saving || uploading || placeSearching || imageSearching}
          onClick={() => { void handleSearchPlaces(); }}
          data-testid="cover-search-submit"
        >
          {placeSearching ? (
            <>
              <LoaderCircle size={12} className={styles.spin} aria-hidden="true" /> 查询中…
            </>
          ) : (
            <>
              <MapPin size={12} aria-hidden="true" /> 查询地址
            </>
          )}
        </button>
      </div>

      <span className={styles.hint}>
        支持 jpg/png/webp，单张最大 {MAX_FILE_SIZE_MIB} MiB；图库查询分两阶段：先选地址，再选图片。
      </span>

      {/* 阶段 A：places 候选 */}
      {placeSearching ? (
        <span className={styles.hint} data-testid="cover-place-loading">查询地址中，请稍候…</span>
      ) : null}
      {placeError ? (
        <span className={styles.hint} data-state="warn" data-testid="cover-place-error">{placeError}</span>
      ) : null}
      {placeResult && placeResult.places.length > 0 ? (
        <CoverPlaces
          places={placeResult.places}
          selectedPlace={selectedPlace}
          disabled={imageSearching || saving}
          onPick={(place) => { void handlePickPlace(place); }}
        />
      ) : null}

      {/* 阶段 B：image candidates */}
      {imageSearching ? (
        <span className={styles.hint} data-testid="cover-image-loading">查询图片中，请稍候…</span>
      ) : null}
      {imageError ? (
        <span className={styles.hint} data-state="warn" data-testid="cover-image-error">{imageError}</span>
      ) : null}
      {imageResult && imageResult.candidates.length > 0 ? (
        <CoverCandidates candidates={imageResult.candidates} onPick={handlePickCandidate} saving={saving} />
      ) : null}

      {/* 兜底提示：阶段 A 无候选时已经在 placeError 给出，不在此处重复。 */}
    </BasicInfoRowShell>
  );
}

function CoverDisplay({
  cover,
  previewUrl,
  onReadPreviewUrl,
}: {
  cover: ProductCover;
  previewUrl: string | null;
  onReadPreviewUrl: (fileId: string, originalName: string) => Promise<string | null>;
}) {
  const [resolvedUrl, setResolvedUrl] = useState<string | null>(previewUrl);

  useEffect(() => {
    setResolvedUrl(previewUrl);
  }, [previewUrl]);

  useEffect(() => {
    if (cover.source !== "manualUpload" || resolvedUrl) return;
    let cancelled = false;
    onReadPreviewUrl(cover.fileId, cover.originalName).then((url) => {
      if (!cancelled) setResolvedUrl(url);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [cover, resolvedUrl, onReadPreviewUrl]);

  // 渲染策略：
  //  - manualUpload：用 main 端返回的 data URL（data:${mime};base64,...），已经
  //    在 main 端读完 → base64 → 拼装；不要在这里再做 base64 解码或 FileReader；
  //  - ctripLibrary：直接用 writeImageUrl / thumbnailUrl / previewUrl 之一，
  //    URL 缺失时走 ImagePlus 占位（彻底避免 "不可点又呈现图片" 的歧义态）。
  const displayUrl = cover.source === "manualUpload"
    ? resolvedUrl
    : cover.imageUrl;
  const hasImage = Boolean(displayUrl);

  return (
    <div className={styles.coverDisplay}>
      {hasImage ? (
        <img className={styles.coverThumb} src={displayUrl!} alt={cover.poi || "封面预览"} />
      ) : (
        <div className={styles.coverPlaceholder} aria-hidden="true">
          <ImagePlus size={16} />
        </div>
      )}
      <div className={styles.coverMeta}>
        <div className={styles.rowDisplay}>
          <strong>{cover.poi}</strong>
          <span className={styles.tag} data-tone={cover.source === "manualUpload" ? "warn" : "ok"}>
            {cover.source === "manualUpload" ? "手动上传" : "携程图库"}
          </span>
          <span className={styles.tag}>质量 ≥ {cover.minQuality}</span>
        </div>
        <span className={styles.hint}>{cover.description}</span>
        {cover.source === "ctripLibrary" ? (
          <CtripCoverMeta cover={cover} />
        ) : (
          <span className={styles.hint}>
            文件：{cover.originalName} · {(cover.sizeBytes / 1024).toFixed(1)} KiB · 上传于 {formatTimestamp(cover.uploadedAt)}
            {resolvedUrl ? null : " · 本地副本已失效，请重新上传"}
          </span>
        )}
      </div>
    </div>
  );
}

function CtripCoverMeta({ cover }: { cover: Extract<ProductCover, { source: "ctripLibrary" }> }) {
  return (
    <span className={styles.hint}>
      imageId <span className={styles.rowMetaMono}>{cover.imageId}</span>
      {typeof cover.score === "number" ? <> · 质量分 {cover.score.toFixed(1)}</> : null}
      {cover.resolution ? <> · {cover.resolution}</> : null}
      {cover.selectedAt ? <> · 选中于 {formatTimestamp(cover.selectedAt)}</> : null}
    </span>
  );
}

/**
 * 阶段 A 的 places 候选：始终渲染原生 select，受控于 selectedPlace.stableId；
 * 选中后 select 仍然可见，原生控件直接显示当前已选地址项；用户也可以
 * 重新切换到另一个 place，自动触发新一轮图片查询（不需要先取消再选）。
 * 原生 select 保证键盘可达，并且选项直接带出地点与位置提示，避免
 * 「select + 已选地址摘要」双控件呈现同一信息造成的歧义态。
 */
function CoverPlaces({
  places,
  selectedPlace,
  disabled,
  onPick,
}: {
  places: CtripLibraryPlaceCandidate[];
  selectedPlace: CtripLibraryPlaceCandidate | null;
  disabled: boolean;
  onPick: (place: CtripLibraryPlaceCandidate) => void;
}) {
  return (
    <select
      className={styles.select}
      aria-label="携程图库地点候选"
      data-testid="cover-place-select"
      value={selectedPlace?.stableId ?? ""}
      disabled={disabled}
      onChange={(event) => {
        const place = places.find((candidate) => candidate.stableId === event.target.value);
        if (place) onPick(place);
      }}
    >
      <option value="" disabled>请选择地点</option>
      {places.map((place) => (
        <option key={place.stableId} value={place.stableId}>
          {formatPlaceOption(place)}
        </option>
      ))}
    </select>
  );
}

function formatPlaceOption(place: CtripLibraryPlaceCandidate): string {
  const location = [place.province, place.city, place.district, place.address]
    .filter((part): part is string => Boolean(part?.trim()))
    .join(" · ");
  return location ? `${place.poiName}（${location}）` : place.poiName;
}

/**
 * 阶段 B 的 image candidates 列表：仅渲染图片候选；test id 与 UI 复用 cover-search-candidates
 * 容器，便于既有「cover-candidate-pick」断言继续工作；行级数据走
 * `CtripLibraryImageCandidate`（imageId / imageUrl 必填）。
 */
function CoverCandidates({
  candidates,
  onPick,
  saving,
}: {
  candidates: CtripLibraryImageCandidate[];
  onPick: (candidate: CtripLibraryImageCandidate) => void;
  saving: boolean;
}) {
  return (
    <ul className={styles.coverCandidates} aria-label="携程图库候选" data-testid="cover-search-candidates">
      {candidates.map((candidate) => {
        const selectable = isCandidateSelectable(candidate);
        return (
          <li key={candidate.stableId} className={styles.coverCandidate}>
            <CoverCandidateThumb candidate={candidate} />
            <div className={styles.coverCandidateMeta}>
              <strong>imageId {candidate.imageId}</strong>
              <span className={styles.hint}>
                {typeof candidate.imageId === "number" ? <>imageId <span className={styles.rowMetaMono}>{candidate.imageId}</span></> : null}
                {typeof candidate.score === "number" ? <> · 质量 {candidate.score.toFixed(1)}</> : null}
                {candidate.resolution ? <> · {candidate.resolution}</> : null}
                {candidate.poiName ? <> · {candidate.poiName}</> : null}
              </span>
            </div>
            <button
              type="button"
              className={`${shared.btn} ${shared.btnSm}`}
              data-variant="secondary"
              disabled={!selectable || saving}
              onClick={() => onPick(candidate)}
              data-testid="cover-candidate-pick"
              aria-disabled={!selectable || saving}
              title={selectable ? undefined : "未取到图片：imageId / imageUrl 缺失"}
            >
              {selectable ? "使用" : "未取到图片"}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function CoverCandidateThumb({ candidate }: { candidate: CtripLibraryImageCandidate }) {
  // 渲染缩略图：imageUrl 优先；缺失回退 previewUrl / thumbnailUrl；
  // 三者全缺才走占位元素。
  const src = candidate.imageUrl || candidate.previewUrl || candidate.thumbnailUrl;
  if (src) {
    return (
      <img
        className={styles.coverCandidateThumb}
        src={src}
        alt={candidate.imageId ? `imageId ${candidate.imageId}` : "携程图库图片"}
        loading="lazy"
      />
    );
  }
  return (
    <div className={styles.coverCandidatePlaceholder} aria-hidden="true" data-testid="cover-candidate-placeholder">
      <ImagePlus size={14} />
    </div>
  );
}

/** 「可写入 cover」的判定：必须同时具备 imageId + 任一可用 URL，三者缺一即拒。 */
function isCandidateSelectable(candidate: CtripLibraryImageCandidate): boolean {
  const hasImageId = typeof candidate.imageId === "number"
    && Number.isInteger(candidate.imageId)
    && candidate.imageId > 0;
  const hasUrl = typeof candidate.imageUrl === "string" && candidate.imageUrl.trim().length > 0;
  return hasImageId && hasUrl;
}

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("无法读取文件内容。"));
        return;
      }
      const idx = result.indexOf(",");
      resolve(idx >= 0 ? result.slice(idx + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error("读取文件失败。"));
    reader.readAsDataURL(file);
  });
}

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
