/** 携程图库封面、地点候选与封面搜索结果。 */
/** 携程图库封面：cover.source === "ctripLibrary"。
 *  - imageId / imageUrl 是「用户在 UI 上选中了一张具体图片」的身份与展示
 *    URL，必须在写入 cover 时一并保存，否则下游无法还原当时选中的图；
 *  - 自动化仅以 poi（景点 POI）检索图片；description / minQuality 是可选历史元数据，
 *    不参与选图或准入；
 *  - thumbnailUrl / previewUrl / score / resolution 是 getImageInfo 返回的
 *    派生字段，便于 UI 复核与排查；非必填；
 *  - poiId / poiName 是 getImageInfo 返回的"图片所属 POI"，与候选的搜索
 *    POI（candidate.poiId）可能不同；保留便于产物比对；
 *  - selectedAt 是用户在 UI 上选定该图的 ISO 时间戳，便于审计 / 重选；
 *  - 不持有图片二进制，运行时由 fillAndSavePresentation 阶段从 VBK 图库
 *    重新抓取（命中 cover.poi 后做二次确认）。
 */
export interface CtripLibraryCover {
  source: "ctripLibrary";
  /** 携程图库 imageId，正整数；在 UI 上「一张图」的主键。 */
  imageId: number;
  /** 携程图库图片展示 URL（getImageInfo 返回的 thumbnailUrl / previewUrl / originalUrl 之一）。 */
  imageUrl: string;
  poi: string;
  description?: string;
  minQuality?: number;
  /** 缩略图 URL（200 档），与 imageUrl 不同时保留以便 UI 区分。 */
  thumbnailUrl?: string;
  /** 预览图 URL（500 档），与 imageUrl 不同时保留以便 UI 区分。 */
  previewUrl?: string;
  /** 携程图库图片质量分（noteImgScore / tourImgAiScore）。 */
  score?: number;
  /** 原图分辨率文本，例如 "1280*1917"。 */
  resolution?: string;
  /** getImageInfo 返回的 POI ID（图片所属 POI）。 */
  poiId?: number;
  /** getImageInfo 返回的 POI 名称（图片所属 POI）。 */
  poiName?: string;
  /** UI 上确认选中的时间（ISO 字符串）。 */
  selectedAt?: string;
  /** 备用携程图库图片；自动化写入封面时会在主图失败后按顺序尝试。 */
  alternates?: CtripLibraryCoverAlternate[];
}

export interface CtripLibraryCoverAlternate {
  imageId: number;
  imageUrl: string;
  poi: string;
  thumbnailUrl?: string;
  previewUrl?: string;
  score?: number;
  resolution?: string;
  poiId?: number;
  poiName?: string;
  selectedAt?: string;
}

/** 手动上传封面：cover.source === "manualUpload"。
 *  - fileId / originalName / mimeType / sizeBytes / uploadedAt 由 main 端
 *    cover:uploadManual 分配 / 持久化，product JSON 仅保留引用与元数据；
 *  - 真正的图片字节只落本机 covers 目录，绝不写入 product JSON；
 *  - 与 CtripLibraryCover 共享 poi / description / minQuality 字段，方便
 *    UI 通用展示 / 业务代码按 source 分支处理。
 */
export interface ManualUploadCover {
  source: "manualUpload";
  fileId: string;
  originalName: string;
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  sizeBytes: number;
  poi: string;
  description: string;
  minQuality: number;
  uploadedAt: string;
}

/**
 * 手动上传封面在 main 端 covers/cover-meta.json 里持久化的元数据形状。
 * 与 ManualUploadCover 的差别：
 *  - 不含 source / poi / description / minQuality（这些是 product JSON 才有的字段）；
 *  - 是 cover:uploadManual / cover:listManual 等 IPC 返回的稳定类型，独立于
 *    product 上层，便于 renderer / 主流程按"纯存储元数据"使用。
 */
export interface ManualUploadCoverMeta {
  fileId: string;
  originalName: string;
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  sizeBytes: number;
  uploadedAt: string;
}

/** 携程图库查询候选图（main 端查询携程图片库后返回给 UI 的最小信息）。
 *  - stableId / index：stableId 优先用于写回 cover；index 用于回放与排查；
 *  - quality / resolution：用于在 UI 上直接展示 + 业务挑选（findBestCtripLibraryImage）；
 *  - previewUrl / thumbnailUrl / imageUrl：UI 展示 / 写回 product cover 用的
 *    图片 URL；imageUrl 优先于 previewUrl / thumbnailUrl，是写入 cover.imageUrl
 *    的首选，没有时回退 previewUrl / thumbnailUrl / originalUrl；
 *  - imageId / poiId / poiName / score / fileName / districtName / countryName：
 *    与 getImageInfo 拼装后的字段；imageId 缺失时 UI 走「未取到图库图片」错误，
 *    不展示占位；
 *  - imageResolved：true 表示数据来自 getImageInfo 真实解析；false / undefined
 *    表示仅有 DOM 占位（已废弃，新链路只走 getImageInfo）。
 */
export interface CtripLibraryImageCandidate {
  stableId: string;
  index: number;
  quality: string;
  resolution: string;
  /** 写回 cover.imageUrl 的首选 URL；缺失时 UI / 自动降级回 previewUrl / thumbnailUrl / originalUrl。 */
  imageUrl?: string;
  previewUrl?: string;
  thumbnailUrl?: string;
  rawText?: string;
  imageId?: number;
  poiId?: number;
  poiName?: string;
  score?: number;
  fileName?: string;
  districtName?: string;
  countryName?: string;
  /** 来源标识：true = 数据来自 getImageInfo 真实解析。 */
  imageResolved?: boolean;
}

/** 携程图库查询的地点候选（suggestpoi.json → 地址 / 景点列表）。
 *  - poiId / poiName 是 suggestPoi 必填字段，决定后续 searchImage 的 tag；
 *  - address / province / city / district 由 suggestPoi 响应里可读字段抽出，
 *    缺时为 null；UI 用它们展示完整地址行；
 *  - stableId：UI 选中后回传给 main 端「按该 place 取 imageIds」时使用的稳定主键；
 *    形如 `poi:${poiId}`；UI 不要自造；
 *  - index：suggestPoi 响应里的原始顺序（0..N），便于排查与回放；
 *  - rawText：调试用 raw 摘要（poiId + name），不进日志链路。
 */
export interface CtripLibraryPlaceCandidate {
  stableId: string;
  index: number;
  /** suggestPoi 返回的 POI ID；后续 searchImage 的 PoiId 标签值。 */
  poiId: number;
  /** suggestPoi 返回的 POI 名称（景点 / 地址名）。 */
  poiName: string;
  /** 完整地址文本，缺时为 null。 */
  address?: string | null;
  province?: string | null;
  city?: string | null;
  district?: string | null;
  /** 调试用 raw 摘要，IPC 不记日志。 */
  rawText?: string;
}

/** 携程图库地点搜索结果：keyword + places + fetchedAt。
 *  - keyword 是 trim 后的用户输入；
 *  - places 是合法候选（poiId + poiName 都齐备）按 suggestPoi 原始顺序排列；
 *  - candidates-after-dedup / imageIds 等旧字段不保留：阶段 A 不涉及图。
 *  - 错误由查询函数直接抛出（业务失败 / 网络失败 / 鉴权失败等），不在本结构
 *    里表达。
 */
export interface CtripLibraryPlaceSearchResult {
  keyword: string;
  places: CtripLibraryPlaceCandidate[];
  fetchedAt: string;
}

/** 携程图库查询结果：来源输入 + 候选数组。
 *  - source 与 cover.source 同名 ctripLibrary 便于直接喂给 ctripLibrary 写入路径；
 *  - candidates 为空时表示未匹配，UI 需明确告知用户；
 *  - 错误由查询函数直接抛出，不在本结构里表达；
 *  - 当前链路只走 getImageInfo：keyword / poi 字段保留「输入回显」用，
 *    - keyword：用户输入的 imageIds 字符串（逗号 / 空格 / 换行分隔），
 *      方便 UI 不改 stat shape 的前提下看到「我刚搜的是什么 ID」；
 *    - poi：恒为空字符串（不再做地点搜索）。
 *  - callers 仅依赖 candidates / fetchedAt；keyword / poi 是给 UI 渲染 / 调试用。
 */
export interface CtripLibrarySearchResult {
  keyword: string;
  poi: string;
  candidates: CtripLibraryImageCandidate[];
  fetchedAt: string;
}

/** product JSON 中的封面对象总集（discriminated union）。 */
export type ProductCover = CtripLibraryCover | ManualUploadCover;

export interface CoverPlaceCandidate {
  stableId: string;
  label: string;
  poiName: string;
  poiId: number | null;
  kind: "keyword" | "scenic" | "spot" | "city";
  detail?: string;
  imageUrl?: string;
  imageId?: number;
  score?: number;
  resolution?: string;
  imageInfoPoiId?: number;
  imageInfoPoiName?: string;
}

export interface CoverPlaceSearchResult {
  keyword: string;
  candidates: CoverPlaceCandidate[];
  errors: Array<{ variant: string; message: string }>;
  fetchedAt: string;
}
