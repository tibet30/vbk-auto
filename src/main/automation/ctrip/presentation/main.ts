/**
 * 产品图文页（productImageText）页面层 barrel：
 *   - selectCtripLibraryImage：在「从图库资源导入」弹窗里搜索 poi 并按已解析
 *     景点 POI 图片，确认协议并提交；
 *   - selectCtripLibraryCover / bindCtripLibraryPresentationImages：在已经
 *     持久化 imageId 的前提下，依次绑定封面 + 景点配图；
 *   - fillAndSavePresentation：以显式 productId 接口保存推荐理由、产品
 *     特点与封面，每步回读成功后直接返回；不做 DOM 导航或推进。
 * 页面与定位器统一使用携程自动化的 Playwright 类型边界。
 *
 * 拆分子文件：
 *   - presentation/select.ts       : 携程图库弹窗搜图 + 工具函数；
 *   - presentation/cover-attempts.ts : ctripLibraryCoverAttempts（主图 +
 *                                    alternates[] 合并去重）；
 *   - presentation/save.ts         : selectCtripLibraryCover / bind* /
 *                                    fillAndSavePresentation 主入口。
 */

export { RECOMMENDATION_CATEGORIES } from "../../schema/schema-definitions.js";
export {
  selectCtripLibraryImage,
  fillFirstVisible,
  selectSearchOption,
} from "./presentation/select.js";
export { ctripLibraryCoverAttempts } from "./presentation/cover-attempts.js";
export {
  selectCtripLibraryCover,
  bindCtripLibraryPresentationImages,
  fillAndSavePresentation,
  type PresentationWriteOptions,
} from "./presentation/save.js";

// Re-export types referenced by external tests.
export type { LibraryImageParams } from "./presentation/select.js";
export type { CtripLibraryCoverCandidate } from "./presentation/cover-attempts.js";