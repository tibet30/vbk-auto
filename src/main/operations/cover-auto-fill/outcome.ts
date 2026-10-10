/**
 * applyAutoCoverFill 的对外 outcome 形状：
 *   - written：cover 或其内部 fallback 是否改变了 product；false = nextProduct === product；
 *   - missingPoiImages：仍有未找到图片的 POI（仅在 written=true 时存在）；
 *   - reason：没写时的简短原因（不含敏感字段），用于 console.info / 日志；
 *   - keyword：触发这次补齐时用的关键词（用于日志诊断）；
 *   - imageId / imageIds：选出来的 imageId（仅在 written=true 时存在）；
 *   - spotImagesWritten：写入 itinerary[].spots[].images 的图张数。
 */

export interface AutoCoverFillOutcome {
  /** Whether cover or its internal fallback changed the product; false means nextProduct === product. */
  written: boolean;
  missingPoiImages?: string[];
  /** 没写时的简短原因（不会含任何敏感字段），用于 console.info / 日志。 */
  reason: string;
  /** 触发这次补齐时用的关键词（用于日志诊断）。 */
  keyword?: string;
  /** 选出来的 imageId（仅在 written=true 时存在）。 */
  imageId?: number;
  /** 实际准备好的 imageId 列表，第一张是主图，其余是备用图。 */
  imageIds?: number[];
  /** 阶段三实际写入 itinerary[].spots[].images 的图张数（仅在 written=true 时存在，0 表示无剩余图可归属）。 */
  spotImagesWritten?: number;
}