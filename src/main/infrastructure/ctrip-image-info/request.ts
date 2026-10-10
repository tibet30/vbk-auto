/**
 * getImageInfo 请求体构造 + 模块常量。
 *
 *   - buildCtripImageInfoRequest：去重 + 过滤非正整数后构造请求头；
 *   - GET_IMAGE_INFO_ENDPOINT / *_TIMEOUT_MS / CTRIP_IMAGE_INFO_REFERRER：
 *     模块常量；改这里就改了所有调用方。
 */

import type {
  CtripImageInfoRequest,
  CtripImageInfoUrlOption,
} from "./types.js";

export const GET_IMAGE_INFO_ENDPOINT = "https://online.ctrip.com/restapi/soa2/12719/getImageInfo";
export const CTRIP_IMAGE_INFO_BROWSER_REQUEST_TIMEOUT_MS = 12_000;
export const CTRIP_IMAGE_INFO_EVALUATE_TIMEOUT_MS = 15_000;
export const CTRIP_IMAGE_INFO_REFERRER =
  "https://vbooking.ctrip.com/product/input/productImageText?pattern=1&from=vbk";

/**
 * getImageInfo 请求体（对齐 VBK SOA 其它接口 + 用户提供的真实请求）。
 *  - contentType: "json" 与 head 的完整字段族与 hotel/vehicle resource 请求一致；
 *  - returnTagTypes：固定 4 类；
 *  - urlOptions：200 + 500 两档，带 quality / type，UI 分别做缩略图 / 预览图；
 *  - imageIds：调用方传入（去重 + 过滤非正整数）。
 */
export function buildCtripImageInfoRequest(args: {
  cid: string;
  imageIds: ReadonlyArray<number>;
}): CtripImageInfoRequest {
  const ids = uniquePositiveIntegers(args.imageIds);
  if (ids.length === 0) throw new Error("查询携程图库图片必须提供至少一个 imageId。");
  const defaultUrlOptions: ReadonlyArray<CtripImageInfoUrlOption> = [
    { width: 200, height: 200, quality: 0.9, type: "R" },
    { width: 500, height: 500, quality: 0.9, type: "R" },
  ];
  return {
    contentType: "json",
    head: {
      cid: args.cid || "",
      ctok: "",
      cver: "1.0",
      lang: "01",
      sid: "8888",
      syscode: "09",
      auth: "",
      xsid: "",
      extension: [],
    },
    returnTagTypes: ["Attraction", "Country", "District", "PoiId"],
    urlOptions: defaultUrlOptions,
    imageIds: ids,
  };
}

function uniquePositiveIntegers(values: ReadonlyArray<number>): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const value of values) {
    const coerced = typeof value === "number" ? value : Number(value);
    if (!Number.isInteger(coerced) || coerced <= 0) continue;
    if (seen.has(coerced)) continue;
    seen.add(coerced);
    out.push(coerced);
  }
  return out;
}