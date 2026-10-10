/**
 * 封面 POI 候选并行查询的对外契约：
 *   - CoverPlaceImageInfoMap：按 imageId 索引的图库信息 Map；
 *   - CoverPlaceBrowser：注入式 browser 接口（仅用 suggestPoiDetail，可选 fetchCtripImageInfo）；
 *   - CoverPlaceSearchOptions：搜索选项（variants / logger / imageInfoEndpoint）；
 *   - DEFAULT_VARIANTS：默认 suffix 列表（景区 / 景点 / 城市）。
 *
 * 子文件"代码细节"在 ./candidate.ts（构造）/ ./search.ts（主入口）/ ./merge.ts（图片回填）。
 */

import type { PoiSuggestDetailResult } from "../../../shared/contracts.js";
import type { CoverPlaceCandidate } from "../../../shared/contracts-types.js";
import type { CtripLibraryImageInfo } from "../ctrip-image-info.js";
import type { CoverPlaceSearchLogger } from "../cover-place-search-logger.js";

export const DEFAULT_VARIANTS: ReadonlyArray<{ suffix: string; kind: CoverPlaceCandidate["kind"] }> = [
  { suffix: "景区", kind: "scenic" },
  { suffix: "景点", kind: "spot" },
  { suffix: "城市", kind: "city" },
];

/** 携程图库图片查询结果按 imageId 索引；非 Success Ack / 网络异常 → 抛错。 */
export type CoverPlaceImageInfoMap = ReadonlyMap<number, CtripLibraryImageInfo>;

export interface CoverPlaceBrowser {
  /** 复用 suggestPoiDetail 的 evaluate 路径；不要直接 import automation。 */
  suggestPoiDetail(keyword: string): Promise<PoiSuggestDetailResult>;
  /**
   * 批量查询 getImageInfo：cover 候选里抽到 imageId 时调用。
   *  - 可选：测试可注入 fake；未注入时 imageUrl 只走 textFields 兜底；
   *  - 抛错由 searchCoverPlaceCandidates 捕获并写到 errors，不让候选整体失败。
   */
  fetchCtripImageInfo?(imageIds: ReadonlyArray<number>): Promise<CoverPlaceImageInfoMap>;
}

export interface CoverPlaceSearchOptions {
  /** 自定义 keyword variants；缺省走 DEFAULT_VARIANTS + 原始 keyword。 */
  variants?: ReadonlyArray<{ suffix: string; kind: CoverPlaceCandidate["kind"] }>;
  /** 单 variant 提示性的并发上限；目前发 Promise.all，不分批。 */
  /**
   * 可选 logger：cover-ipc 在主进程注入 console.warn 桥接；测试可注入 spy / silent。
   * 不传 → no-op，保证零行为变化（纯函数默认仍可用）。
   */
  logger?: CoverPlaceSearchLogger;
  /**
   * getImageInfo endpoint，仅用于日志；默认走 ctrip-image-info 内置 endpoint。
   * 透传而不直接 import，避免基础设施层循环依赖。
   */
  imageInfoEndpoint?: string;
}