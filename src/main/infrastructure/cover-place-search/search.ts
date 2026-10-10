/**
 * 封面 POI 候选并行查询主入口：
 *   - searchCoverPlaceCandidates：并行请求（keyword + variants）→ dedup → 图片补全。
 *
 * 流程：
 *   1. trimmed keyword 校验后发搜索请求（含 query 自身 + DEFAULT_VARIANTS 后缀）；
 *   2. 任意 variant 失败 → errors 累加，其它 variant 继续；
 *   3. dedup：按 stableId（poiId 优先）合并；kind 优先级 keyword > scenic > spot > city；
 *   4. 图片补全：聚合 imageId → 一次 fetchCtripImageInfo → 回填（按 imageId 反向索引）。
 *
 * 设计约束：
 *   - 不直接 import automation / cover-storage，避免循环依赖；
 *   - 单个 variant 失败不中断其它 variant；
 *   - imageId 缺失 / fetchCtripImageInfo 抛错 → 候选仍返回，UI 走占位图。
 */

import type { PoiSuggestDetailResult } from "../../../shared/contracts.js";
import type { CoverPlaceCandidate, CoverPlaceSearchResult } from "../../../shared/contracts-types.js";
import {
  EMPTY_COVER_PLACE_SEARCH_CONTEXT,
  SILENT_COVER_PLACE_LOGGER,
  truncateImageIdsForLog,
} from "../cover-place-search-logger.js";
import type { CoverPlaceBrowser, CoverPlaceSearchOptions } from "./types.js";
import { DEFAULT_VARIANTS } from "./types.js";
import { buildCandidate } from "./candidate.js";
import {
  mergeImageInfo,
  normaliseName,
  recordImageIdCandidate,
  stripUndefined,
} from "./merge.js";

export async function searchCoverPlaceCandidates(
  browser: CoverPlaceBrowser,
  keyword: string,
  options: CoverPlaceSearchOptions = {},
): Promise<CoverPlaceSearchResult> {
  const logger = options.logger ?? SILENT_COVER_PLACE_LOGGER;
  const endpoint = options.imageInfoEndpoint ?? "";
  const trimmed = keyword.trim();
  if (!trimmed) {
    return { keyword: "", candidates: [], errors: [], fetchedAt: new Date().toISOString() };
  }
  logger({ event: "search-start", keyword: trimmed });
  const variants = options.variants ?? DEFAULT_VARIANTS;
  const tasks: Array<{ kind: CoverPlaceCandidate["kind"]; promise: Promise<PoiSuggestDetailResult> }> = [
    { kind: "keyword", promise: browser.suggestPoiDetail(trimmed) },
    ...variants.map((variant) => ({
      kind: variant.kind,
      promise: browser.suggestPoiDetail(`${trimmed}${variant.suffix}`),
    })),
  ];
  const settled = await Promise.allSettled(tasks.map((task) => task.promise));
  const errors: CoverPlaceSearchResult["errors"] = [];
  const deduped = new Map<string, CoverPlaceCandidate>();
  // imageId → 候选 key 列表：用于一次 fetchCtripImageInfo 后回填多候选。
  const imageIdToCandidateKeys = new Map<number, string[]>();
  settled.forEach((result, index) => {
    const { kind } = tasks[index];
    const variantLabel = kind === "keyword" ? trimmed : `${trimmed}${variants[index - 1]?.suffix ?? ""}`;
    if (result.status === "rejected") {
      const message = result.reason instanceof Error ? result.reason.message : String(result.reason ?? "未知错误");
      errors.push({ variant: variantLabel, message });
      return;
    }
    const detail = result.value;
    for (const candidate of detail.candidates) {
      const built = buildCandidate(candidate, kind);
      if (!built) continue;
      const key = built.poiId !== null ? `poiId:${built.poiId}` : `name:${normaliseName(built.poiName)}`;
      const existing = deduped.get(key);
      if (!existing) {
        deduped.set(key, built);
        recordImageIdCandidate(imageIdToCandidateKeys, built, key);
        continue;
      }
      // 同名/同 id：保留 kind 优先级 keyword > scenic > spot > city，
      // 这样原始关键词的命中信息最丰富，最贴近运营意图。
      const priority = { keyword: 0, scenic: 1, spot: 2, city: 3 } as const;
      if (priority[built.kind] < priority[existing.kind]) {
        // 替换优先级：existing 上的 imageUrl / imageId / detail 不要丢。
        const merged: CoverPlaceCandidate = {
          ...built,
          detail: built.detail ?? existing.detail,
          imageUrl: built.imageUrl ?? existing.imageUrl,
          imageId: built.imageId ?? existing.imageId,
          score: built.score ?? existing.score,
          resolution: built.resolution ?? existing.resolution,
          imageInfoPoiId: built.imageInfoPoiId ?? existing.imageInfoPoiId,
          imageInfoPoiName: built.imageInfoPoiName ?? existing.imageInfoPoiName,
        };
        deduped.set(key, merged);
        recordImageIdCandidate(imageIdToCandidateKeys, merged, key);
      } else {
        // 只补缺字段：existing 没图但 built 有图时一并补上。
        const merged: CoverPlaceCandidate = {
          ...existing,
          detail: existing.detail ?? built.detail,
          imageUrl: existing.imageUrl ?? built.imageUrl,
          imageId: existing.imageId ?? built.imageId,
          score: existing.score ?? built.score,
          resolution: existing.resolution ?? built.resolution,
          imageInfoPoiId: existing.imageInfoPoiId ?? built.imageInfoPoiId,
          imageInfoPoiName: existing.imageInfoPoiName ?? built.imageInfoPoiName,
        };
        deduped.set(key, merged);
        recordImageIdCandidate(imageIdToCandidateKeys, merged, key);
      }
    }
  });

  // 图片补全：聚合所有候选的 imageId（去重）→ 一次 fetchCtripImageInfo → 回填。
  const aggregatedImageIds = [...imageIdToCandidateKeys.keys()];
  // 中间观察点：候选合并去重完成后立即打日志，方便排查「无候选 / 无 imageId」类问题。
  logger({
    event: "candidates-after-dedup",
    candidateCount: deduped.size,
    withImageIdCount: aggregatedImageIds.length,
    imageIds: truncateImageIdsForLog(aggregatedImageIds),
  });
  if (aggregatedImageIds.length > 0 && browser.fetchCtripImageInfo) {
    logger({
      event: "image-ids-extracted",
      imageIds: truncateImageIdsForLog(aggregatedImageIds),
    });
    logger({
      event: "image-info-request-start",
      imageIds: truncateImageIdsForLog(aggregatedImageIds),
      endpoint,
    });
    const requestStart = Date.now();
    try {
      const infoMap = await browser.fetchCtripImageInfo(aggregatedImageIds);
      const durationMs = Date.now() - requestStart;
      const itemCount = infoMap.size;
      // 仅向 logger 汇报条目数 / imageId 计数 / 耗时；具体 URL 列表由 cover-ipc
      // 在主进程侧重新走 ack / status 推导，避免误传。
      logger({
        event: "image-info-success",
        httpStatus: 200,
        ack: "Success",
        itemCount,
        imageIdCount: aggregatedImageIds.length,
        durationMs,
        // 当前路径未携带 cookie 上下文：cover-place-search 内部 evaluate 暂未
        // 收集 ctx；与 ctrip-library-search 的 suggest-failure 异常分支一致，
        // 走 EMPTY 兜底，不输出虚假信号。
        ctx: EMPTY_COVER_PLACE_SEARCH_CONTEXT,
      });
      for (const [imageId, candidateKeys] of imageIdToCandidateKeys.entries()) {
        const info = infoMap.get(imageId);
        if (!info) continue;
        const merged = mergeImageInfo(info);
        for (const candidateKey of candidateKeys) {
          const current = deduped.get(candidateKey);
          if (!current) continue;
          // 只覆盖 getImageInfo 真的给出值的字段：null/undefined 不得清空
          // 已有的 textFields 兜底（否则拿到半空 item 时缩略图反而丢了）。
          deduped.set(candidateKey, { ...current, ...stripUndefined(merged) });
        }
      }
    } catch (error) {
      const durationMs = Date.now() - requestStart;
      const message = error instanceof Error ? error.message : String(error ?? "未知错误");
      logger({
        event: "image-info-failure",
        message,
        httpStatus: 0,
        durationMs,
        // image-info-failure 发生在 fetchCtripImageInfo 抛出后，调用方拿不到
        // HTTP 状态；httpStatus=0 表示"未取得 HTTP 状态"，与同工程 image-info-success
        // 路径（HTTP 200，但无 cookie 上下文）使用 EMPTY 兜底保持一致。
        ctx: EMPTY_COVER_PLACE_SEARCH_CONTEXT,
      });
      errors.push({ variant: "getImageInfo", message: `图片详情查询失败：${message}` });
    }
  } else if (!browser.fetchCtripImageInfo) {
    // 没注入 fetchCtripImageInfo：留 events 给调用方感知（不算「跳过」）。
    logger({
      event: "skip-image-info",
      reason: "fetchCtripImageInfo 未注入（仅靠 textFields 兜底）",
      candidateCount: deduped.size,
    });
  } else {
    logger({
      event: "skip-image-info",
      reason: "no imageIds from suggestPoi candidates",
      candidateCount: deduped.size,
    });
  }

  const candidates = [...deduped.values()].sort((a, b) => {
    const priority = { keyword: 0, scenic: 1, spot: 2, city: 3 } as const;
    if (priority[a.kind] !== priority[b.kind]) return priority[a.kind] - priority[b.kind];
    return a.label.length - b.label.length || a.label.localeCompare(b.label, "zh-CN");
  });
  return {
    keyword: trimmed,
    candidates,
    errors,
    fetchedAt: new Date().toISOString(),
  };
}