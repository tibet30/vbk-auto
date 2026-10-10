/**
 * product-normalize 的对外类型：
 *   - NormaliseReleaseOptions：safeRelease 选项；
 *   - NormaliseOptions：NormaliseReleaseOptions 的 alias（向后兼容）。
 *
 * safeRelease=true 时强制 release 进入 draft-only（submitReview / publishAfterApproval
 * 都设为 false）。AI / 自动写入路径必须显式传 true；数据库 startup normalize 默认不传，
 * 保留历史 / 人工 release 标记。
 */

export interface NormaliseReleaseOptions {
  /**
   * 强制 release 进入 draft-only：submitReview / publishAfterApproval 一律为 false。
   * AI / 自动写入路径必须显式传 true，否则会把已经人工 / VBK 打开的发布态默默清零。
   * 数据库 startup normalize 默认不传，保留历史 / 人工 release 标记。
   */
  safeRelease?: boolean;
}

/** @deprecated use {@link NormaliseReleaseOptions.safeRelease} instead. */
export type NormaliseOptions = NormaliseReleaseOptions;