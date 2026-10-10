/**
 * 携程图库 suggestPoi / searchImage 请求与解析协议（barrel）：
 *   - endpoints.ts：URL + 超时常量 + emptyHead / clampPageSize / timeoutOrDefault；
 *   - types.ts：所有 interface；
 *   - parse-helpers.ts：共用解析工具（asRecord / optionalString / positiveInteger /
 *     isBusinessSuccess / failureReason / pickPoiList / pickImageList / readImageId /
 *     parsePoiFromEntry）；
 *   - builders.ts：buildSuggestPoiRequest / buildSearchImageRequest +
 *     parseSuggestPoiPayload / parseSuggestPoiPlaces / parseSearchImagePayload。
 */

import type { CoverPlaceSearchSessionContext } from "./cover-place-search-logger.js";
import { EMPTY_COVER_PLACE_SEARCH_CONTEXT } from "./cover-place-search-logger.js";

export {
  CTRIP_LIBRARY_BROWSER_REQUEST_TIMEOUT_MS,
  CTRIP_LIBRARY_EVALUATE_TIMEOUT_MS,
  CTRIP_LIBRARY_REFERRER,
  SEARCH_IMAGE_MAX_PAGE_SIZE,
  SEARCH_IMAGE_ENDPOINT,
  SUGGESTPOI_ENDPOINT,
  clampPageSize,
  emptyHead,
  timeoutOrDefault,
} from "./ctrip-library-protocol/endpoints.js";
export type {
  CtripLibraryRequestHead,
  CtripLibrarySearchBrowser,
  SearchImageParsedItem,
  SearchImageRequest,
  SearchImageResponse,
  SuggestPoiParsedPoi,
  SuggestPoiPlacesResult,
  SuggestPoiRequest,
  SuggestPoiResponse,
} from "./ctrip-library-protocol/types.js";
export {
  asRecord,
  failureReason,
  isBusinessSuccess,
  optionalString,
  parsePoiFromEntry,
  pickImageList,
  pickPoiList,
  positiveInteger,
  readImageId,
} from "./ctrip-library-protocol/parse-helpers.js";
export {
  buildSearchImageRequest,
  buildSuggestPoiRequest,
  parseSearchImagePayload,
  parseSuggestPoiPayload,
  parseSuggestPoiPlaces,
} from "./ctrip-library-protocol/builders.js";

export const EMPTY_CTRIP_SESSION_CONTEXT: CoverPlaceSearchSessionContext = EMPTY_COVER_PLACE_SEARCH_CONTEXT;