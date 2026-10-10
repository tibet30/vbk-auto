/**
 * 携程图库封面查询主入口（cover:searchCtripLibrary 旧链路 / 向后兼容 wrapper）：
 *  1. 调 searchCtripLibraryPlaces 解析所有候选；
 *  2. 优先唯一精确同名 POI；没有精确同名时取首项，同名歧义拒绝自动选择；
 *  3. 调 searchCtripLibraryImagesForPlace 走阶段 B；
 *  4. 任意步骤抛错向上传播。
 *
 * 新代码应**优先**走两阶段入口，让用户在 UI 上先选地址；本 wrapper 仅为旧
 * IPC / 旧测试提供兼容。
 */

import type { CtripLibrarySearchResult } from "../../../shared/contracts-types.js";
import { selectAutomaticLibraryPlace } from "../ctrip-library-place-selection.js";
import type { CtripLibrarySearchBrowser } from "../ctrip-library-protocol.js";
import type { SearchCtripLibraryOptions } from "./options.js";
import { searchCtripLibraryImagesForPlace } from "./images.js";
import { searchCtripLibraryPlaces } from "./places.js";

export async function searchCtripLibraryImages(
  browser: CtripLibrarySearchBrowser,
  keyword: string,
  options: SearchCtripLibraryOptions = {},
): Promise<CtripLibrarySearchResult> {
  const placesResult = await searchCtripLibraryPlaces(browser, keyword, options);
  if (placesResult.places.length === 0) {
    throw new Error(`suggestPoi 未找到匹配 POI：${placesResult.keyword}`);
  }
  const first = selectAutomaticLibraryPlace(placesResult.places, placesResult.keyword);
  return searchCtripLibraryImagesForPlace(
    browser,
    { keyword: placesResult.keyword, place: first },
    // 阶段 A 已经发了 search-start；阶段 B 在 wrapper 链路里不要再发，
    // 否则日志事件序列会出现重复的 search-start。
    { ...options, emitSearchStart: false },
  );
}