import { logWarn } from "../../shared/log-timestamp.js";
/**
 * cover place search 可观测日志：
 *   - 仅做类型 + 一个截断纯函数 + console 桥接，不持有任何 side effect 之外的资源；
 *   - 由 cover-place-search / cover-ipc / ctrip-image-info 三处共享事件 schema；
 *   - 实际 console.warn 输出在 cover-ipc 层注入；基础设施层不直接 console.warn。
 *
 * 安全约束：
 *   - logger payload **绝不**携带 cookie / header / token / 完整图片 URL 列表 /
 *     w-payload-source / 原始响应 body；
 *   - imageId 列表截断到前 20 条，避免生产环境大量候选时刷屏；
 *   - 会话上下文仅暴露布尔 / 计数（hasCid / cookieNameCount / hasGuidCookie /
 *     hasVbkLoginCidCookie），**绝不**输出 cookie 值、cid、URL 里的 query string。
 */

/**
 * cover place search 在关键节点发出的可观测事件：
 *  - "search-start"：搜索开始（携带 trimmed keyword）；
 *  - "suggest-success"：suggestPoi 拿到第一个候选（poiName / poiId / durationMs /
 *    candidateCount + 会话上下文）；
 *  - "suggest-failure"：suggestPoi 失败（message / durationMs / httpStatus /
 *    candidateCount + 会话上下文）；
 *  - "searchImage-success"：searchImage 成功（httpStatus / Ack / imageIdCount /
 *    durationMs + 会话上下文），**不**携带原始 imageIds；
 *  - "searchImage-failure"：searchImage 失败（message / durationMs / httpStatus +
 *    会话上下文）；
 *  - "image-ids-extracted"：从 searchImage 拿到 imageId（即将发起 getImageInfo）；
 *  - "skip-image-info"：无 imageId，跳过 getImageInfo；
 *  - "image-info-request-start"：开始调 getImageInfo（imageIds + endpoint）；
 *  - "image-info-success"：getImageInfo 成功（httpStatus / Ack / itemCount /
 *    imageIdCount / durationMs + 会话上下文）；
 *  - "image-info-failure"：getImageInfo 失败（message / durationMs / httpStatus +
 *    会话上下文）；
 *  - "candidates-after-dedup"：suggestPoi 候选合并去重完成（candidateCount /
 *    withImageIdCount / imageIds 前 20 个）—— 仅旧链路使用，新链路不触发。
 */
export interface CoverPlaceSearchSessionContext {
  /** 是否能从 document.cookie 读到 GUID / vbk_login_cid。 */
  hasCid: boolean;
  /** document.cookie 里实际 cookie 名的数量（不输出具体值或名字）。 */
  cookieNameCount: number;
  /** 是否包含名为 GUID / guid 的 cookie（只表示「键存在」，不含值）。 */
  hasGuidCookie: boolean;
  /** 是否包含名为 vbk_login_cid / VBK_LOGIN_CID 的 cookie（只表示「键存在」）。 */
  hasVbkLoginCidCookie: boolean;
  /** 是否包含 UBT_VID cookie（携程反作弊 visitor ID；不含值）。 */
  hasUbtVidCookie: boolean;
  /** 是否包含 vbkticket cookie（VBK session 票据；不含值）。 */
  hasVbkTicketCookie: boolean;
  /** 是否包含 bticket cookie（VBK 备用票据；不含值）。 */
  hasBticketCookie: boolean;
  /** 是否包含 JSESSIONID cookie（Java session；不含值）。 */
  hasJsSessionIdCookie: boolean;
  /** 是否包含 vbk-menu-business-id cookie（商户 ID；不含值）。 */
  hasBusinessIdCookie: boolean;
  /** 是否包含 _bfa cookie（行为分析标识；不含值）。 */
  hasBfaCookie: boolean;
}

export type CoverPlaceSearchLogEvent =
  | { event: "search-start"; keyword: string }
  | {
      event: "suggest-success";
      poiName: string;
      poiId: number;
      durationMs: number;
      candidateCount: number;
      ctx: CoverPlaceSearchSessionContext;
    }
  | {
      event: "suggest-failure";
      message: string;
      durationMs: number;
      httpStatus: number;
      candidateCount: number;
      ctx: CoverPlaceSearchSessionContext;
    }
  | {
      event: "searchImage-success";
      httpStatus: number;
      ack: string;
      imageIdCount: number;
      durationMs: number;
      ctx: CoverPlaceSearchSessionContext;
    }
  | {
      event: "searchImage-failure";
      message: string;
      durationMs: number;
      httpStatus: number;
      ctx: CoverPlaceSearchSessionContext;
    }
  | {
      event: "candidates-after-dedup";
      candidateCount: number;
      withImageIdCount: number;
      imageIds: ReadonlyArray<number>;
    }
  | { event: "image-ids-extracted"; imageIds: ReadonlyArray<number> }
  | { event: "skip-image-info"; reason: string; candidateCount: number }
  | { event: "image-info-request-start"; imageIds: ReadonlyArray<number>; endpoint: string }
  | {
      event: "image-info-success";
      httpStatus: number;
      ack: string;
      itemCount: number;
      imageIdCount: number;
      durationMs: number;
      ctx: CoverPlaceSearchSessionContext;
    }
  | {
      event: "image-info-failure";
      message: string;
      durationMs: number;
      httpStatus: number;
      ctx: CoverPlaceSearchSessionContext;
    };

export type CoverPlaceSearchLogger = (record: CoverPlaceSearchLogEvent) => void;

/** 默认 logger：no-op；实际 console.warn 桥接由 cover-ipc 注入。 */
export const SILENT_COVER_PLACE_LOGGER: CoverPlaceSearchLogger = () => {};

/**
 * 兜底用的空会话上下文：当调用方未传 ctx 时（例如 ctrip-image-info 的 BrowserView
 * evaluate 路径暂无 cookie 状态汇总），用这个常量满足日志 schema 的必填约束，
 * 避免任何运行时 / 编译时未定义行为；与同工程其它基础设施模块的兜底方式一致。
 * 一律 false / 0，与"未观察到任何 cookie 信号"语义对齐。
 */
export const EMPTY_COVER_PLACE_SEARCH_CONTEXT: CoverPlaceSearchSessionContext = {
  hasCid: false,
  cookieNameCount: 0,
  hasGuidCookie: false,
  hasVbkLoginCidCookie: false,
  hasUbtVidCookie: false,
  hasVbkTicketCookie: false,
  hasBticketCookie: false,
  hasJsSessionIdCookie: false,
  hasBusinessIdCookie: false,
  hasBfaCookie: false,
};

/** 给 imageId 列表做「最多展示前 N 个」的截断；纯函数便于单测。 */
export function truncateImageIdsForLog(imageIds: ReadonlyArray<number>, max = 20): number[] {
  if (imageIds.length <= max) return [...imageIds];
  return imageIds.slice(0, max);
}

/** 日志前缀：与产品其它诊断日志保持 [scope.action] 风格。 */
export const COVER_SEARCH_LOG_PREFIX = "[cover.searchCtripLibrary]";
export const COVER_IMAGE_INFO_LOG_PREFIX = "[cover.ctripImageInfo]";

/** 把 imageId 数组拍平成最多 20 个 + total 数字的字符串，避免日志里出现几百个 id。 */
function formatImageIdsForLog(imageIds: ReadonlyArray<number>): string {
  const preview = truncateImageIdsForLog(imageIds);
  if (imageIds.length <= preview.length) return `[${preview.join(",")}]`;
  return `[${preview.join(",")},+${imageIds.length - preview.length}]`;
}

/**
 * 把会话上下文渲染成「不含敏感值」的字符串段：
 *  hasCid=true/false cookieNames=N hasGuid=true/false hasVbkLoginCid=true/false
 * 仅布尔 + 计数；不进 cookie 名 / 值 / cid / URL query。
 */
function formatSessionContext(ctx: CoverPlaceSearchSessionContext = EMPTY_COVER_PLACE_SEARCH_CONTEXT): string {
  return (
    `hasCid=${ctx.hasCid ? "true" : "false"} ` +
    `cookieNames=${ctx.cookieNameCount} ` +
    `hasGuid=${ctx.hasGuidCookie ? "true" : "false"} ` +
    `hasVbkLoginCid=${ctx.hasVbkLoginCidCookie ? "true" : "false"} ` +
    `hasUbtVid=${ctx.hasUbtVidCookie ? "true" : "false"} ` +
    `hasVbkTicket=${ctx.hasVbkTicketCookie ? "true" : "false"} ` +
    `hasBticket=${ctx.hasBticketCookie ? "true" : "false"} ` +
    `hasJsSessionId=${ctx.hasJsSessionIdCookie ? "true" : "false"} ` +
    `hasBizId=${ctx.hasBusinessIdCookie ? "true" : "false"} ` +
    `hasBfa=${ctx.hasBfaCookie ? "true" : "false"}`
  );
}

/**
 * 把 cover-place-search 的结构化事件转成 console.warn 文本：
 *  - 全部走 console.warn（按用户要求与现有产品日志风格一致）；
 *  - 不打 cookie 值 / cookie 名 / header / token / w-payload-source /
 *    原始响应 body / URL query string；
 *  - durationMs 用 ms 单位，便于排查超时。
 */
export function createConsoleCoverPlaceLogger(args?: {
  /** 日志前缀覆盖；默认 COVER_SEARCH_LOG_PREFIX。 */
  prefix?: string;
  /** console 实现；默认全局 console.warn，便于测试注入 spy。 */
  sink?: (line: string) => void;
}): CoverPlaceSearchLogger {
  const prefix = args?.prefix ?? COVER_SEARCH_LOG_PREFIX;
  const sink = args?.sink ?? ((line: string) => logWarn(line));
  return (record) => {
    switch (record.event) {
      case "search-start":
        sink(`${prefix} search.start keyword=${JSON.stringify(record.keyword)}`);
        return;
      case "suggest-success":
        sink(
          `${prefix} suggest.success poiName=${JSON.stringify(record.poiName)} ` +
            `poiId=${record.poiId} durationMs=${record.durationMs} ` +
            `candidateCount=${record.candidateCount} ` +
            formatSessionContext(record.ctx),
        );
        return;
      case "suggest-failure":
        sink(
          `${prefix} suggest.failure message=${JSON.stringify(record.message)} ` +
            `httpStatus=${record.httpStatus} durationMs=${record.durationMs} ` +
            `candidateCount=${record.candidateCount} ` +
            formatSessionContext(record.ctx),
        );
        return;
      case "searchImage-success":
        sink(
          `${prefix} searchImage.success httpStatus=${record.httpStatus} ` +
            `ack=${record.ack} imageIdCount=${record.imageIdCount} ` +
            `durationMs=${record.durationMs} ` +
            formatSessionContext(record.ctx),
        );
        return;
      case "searchImage-failure":
        sink(
          `${prefix} searchImage.failure message=${JSON.stringify(record.message)} ` +
            `httpStatus=${record.httpStatus} durationMs=${record.durationMs} ` +
            formatSessionContext(record.ctx),
        );
        return;
      case "candidates-after-dedup":
        sink(
          `${prefix} candidates.after_dedup candidateCount=${record.candidateCount} ` +
            `withImageIdCount=${record.withImageIdCount} imageIds=${formatImageIdsForLog(record.imageIds)}`,
        );
        return;
      case "image-ids-extracted":
        sink(
          `${prefix} image_ids.extracted imageIds=${formatImageIdsForLog(record.imageIds)}`,
        );
        return;
      case "skip-image-info":
        sink(
          `${prefix} skip.get_image_info reason=${JSON.stringify(record.reason)} ` +
            `candidateCount=${record.candidateCount}`,
        );
        return;
      case "image-info-request-start":
        sink(
          `${prefix} image_info.request.start endpoint=${record.endpoint} ` +
            `imageIds=${formatImageIdsForLog(record.imageIds)}`,
        );
        return;
      case "image-info-success":
        sink(
          `${prefix} image_info.success httpStatus=${record.httpStatus} ack=${record.ack} ` +
            `itemCount=${record.itemCount} imageIdCount=${record.imageIdCount} ` +
            `durationMs=${record.durationMs} ` +
            formatSessionContext(record.ctx),
        );
        return;
      case "image-info-failure":
        sink(
          `${prefix} image_info.failure message=${JSON.stringify(record.message)} ` +
            `httpStatus=${record.httpStatus} durationMs=${record.durationMs} ` +
            formatSessionContext(record.ctx),
        );
        return;
    }
  };
}

/**
 * 把 ctrip-image-info 的结构化事件转成 console.warn 文本；
 * 同样不打 cookie 值 / cookie 名 / header / token / w-payload-source /
 * 原始响应 body / URL query。
 */
export function createConsoleCtripImageInfoLogger(args?: {
  prefix?: string;
  sink?: (line: string) => void;
}): (record: import("./ctrip-image-info.js").CtripImageInfoLogEvent) => void {
  const prefix = args?.prefix ?? COVER_IMAGE_INFO_LOG_PREFIX;
  const sink = args?.sink ?? ((line: string) => logWarn(line));
  return (record) => {
    switch (record.event) {
      case "fetch-start":
        sink(
          `${prefix} fetch.start endpoint=${record.endpoint} ` +
            `timeoutMs=${record.timeoutMs} imageIdCount=${record.imageIdCount} ` +
            formatSessionContext(record.ctx),
        );
        return;
      case "fetch-end":
        sink(
          `${prefix} fetch.success httpStatus=${record.httpStatus} ack=${record.ack} ` +
            `itemCount=${record.itemCount} imageIdCount=${record.imageIdCount} ` +
            `durationMs=${record.durationMs} ` +
            formatSessionContext(record.ctx),
        );
        return;
      case "fetch-failure":
        sink(
          `${prefix} fetch.failure endpoint=${record.endpoint} ` +
            `httpStatus=${record.httpStatus} message=${JSON.stringify(record.message)} ` +
            `durationMs=${record.durationMs} ` +
            formatSessionContext(record.ctx),
        );
        return;
    }
  };
}
