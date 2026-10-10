/**
 * 携程图库封面查询的对外选项形状。
 *
 * 仅本模块使用，barrel 透传即可。
 */

import type { CoverPlaceSearchLogger } from "../cover-place-search-logger.js";

export interface SearchCtripLibraryOptions {
  browserRequestTimeoutMs?: number;
  evaluateTimeoutMs?: number;
  /** 可选 logger：cover-ipc 注入 console.warn 桥接；测试可注入 spy / silent。 */
  logger?: CoverPlaceSearchLogger | null;
  /**
   * 是否发出 search-start 事件（默认 true）。
   * 仅 searchCtripLibraryImagesForPlace 内部使用：
   * 旧兼容 wrapper searchCtripLibraryImages 在已经走过 searchCtripLibraryPlaces
   * 之后调用阶段 B 时会传入 false，避免重复的 search-start 事件。
   */
  emitSearchStart?: boolean;
}