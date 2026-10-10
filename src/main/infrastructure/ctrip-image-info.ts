/**
 * 携程图库图片详情查询（getImageInfo）barrel。
 *
 * 本文件不持有具体实现：内容按"职责"拆分到 `./ctrip-image-info/` 子目录。
 *
 * 子模块分工：
 *   - types.ts      所有公开契约 / 形状 / Logger 事件 / 超时类；
 *   - request.ts    buildCtripImageInfoRequest + 模块常量（endpoint / timeout）；
 *   - parse.ts      纯函数 parseCtripImageInfoPayload（供单元测试与离线解析）；
 *   - fetch.ts      主入口 fetchCtripImageInfo / fetchCtripImageInfoMap（BrowserView 内 fetch）。
 *
 * 调用方继续 `import {...} from "./ctrip-image-info.js"`，符号由下面 4 行
 * 再聚合出去。
 */

export type {
  CtripImageUrlVariant,
  CtripLibraryImageInfo,
  CtripImageInfoResponse,
  CtripImageInfoRequestHead,
  CtripImageInfoUrlOption,
  CtripImageInfoRequest,
  CtripImageInfoBrowserSummary,
  CtripImageInfoLogger,
  CtripImageInfoLogEvent,
  CtripImageInfoTimeoutOptions,
} from "./ctrip-image-info/types.js";
export { CtripImageInfoTimeoutError } from "./ctrip-image-info/types.js";

export {
  GET_IMAGE_INFO_ENDPOINT,
  CTRIP_IMAGE_INFO_BROWSER_REQUEST_TIMEOUT_MS,
  CTRIP_IMAGE_INFO_EVALUATE_TIMEOUT_MS,
  CTRIP_IMAGE_INFO_REFERRER,
  buildCtripImageInfoRequest,
} from "./ctrip-image-info/request.js";

export { parseCtripImageInfoPayload } from "./ctrip-image-info/parse.js";

export {
  fetchCtripImageInfo,
  fetchCtripImageInfoMap,
} from "./ctrip-image-info/fetch.js";