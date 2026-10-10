/**
 * VBK 流程的「tab / section 导航 + 安全保存 + 跨产品入口跳转」原语 barrel。
 *
 * 本文件不持有具体实现：实际内容按"职责"拆分到 `./tabs/` 子目录下的 5
 * 个文件，原模块导入路径（`./tabs.js`）由这里重新聚合转发，所有调用方零改动。
 *
 * 子模块分工：
 *   - click-section.ts            clickSection / waitForSectionEnabled 的 tab 跳转原语（保持源码邻接以锁住 basic-info-fixes 切片）；
 *   - click-safe-save.ts          clickSafeSave / submitCurrentSectionAndNext 的安全保存原语；
 *   - save-then-advance.ts        「保存 → 进入目标 tab」状态机 + findUnlockedSectionLabel / findActiveTabLabel；
 *   - editor-entry.ts             openProductEditor / ensureBasicInfoTabVisible 的跨产品入口定位；
 *   - url-helpers.ts              PRODUCT_IMAGE_TEXT_REGEX / isProductImageTextUrl / isItineraryUrl 的纯 URL 识别。
 *
 * 调用方继续 `import {...} from "./tabs.js"`，符号由下面这五行再聚合出去。
 *
 * 测试守约：
 *   - basic-info-fixes/basic-info-fixes.ctrip-part2.test.ts 等用 `readCtripSource()`
 *     在拼接过的源码里按 `indexOf` 切片，依赖 `saveThenAdvance ↔ findUnlockedSectionLabel`
 *     与 `clickSection ↔ waitForSectionEnabled` 的源码邻接。子文件保留这两个邻接关系。
 *   - `basic-info/location.ts` 仍保留 `openProductEditor` sentinel（source-slicing 占位），
 *     真实实现从此处的 editor-entry.ts 取。
 */

export {
  clickSection,
  waitForSectionEnabled,
} from "./tabs/click-section.js";

export {
  clickSafeSave,
  submitCurrentSectionAndNext,
} from "./tabs/click-safe-save.js";

export {
  saveThenAdvance,
  findUnlockedSectionLabel,
  findActiveTabLabel,
} from "./tabs/save-then-advance.js";

export {
  openProductEditor,
  ensureBasicInfoTabVisible,
} from "./tabs/editor-entry.js";

export {
  PRODUCT_IMAGE_TEXT_REGEX,
  isProductImageTextUrl,
  isItineraryUrl,
} from "./tabs/url-helpers.js";
