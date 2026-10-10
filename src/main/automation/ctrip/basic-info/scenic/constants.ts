/**
 * 国家景区（#scenic_area）自动录入的常量集合。
 *
 *   - DIRECT_ADMIN_MUNICIPALITIES：VBK 的 PROVINCE 接口明确不返回四个直辖市，
 *     这些目的地直接跳过省份下拉，进入下级景区/景点选择；
 *   - SCENIC_SEARCH_TIMEOUT_MS：单次级联下拉等待"出现可用项"的轮询上限。
 */

/** VBK PROVINCE 接口不返回的四个直辖市；这些目的地直接录入下级景区/景点。 */
export const DIRECT_ADMIN_MUNICIPALITIES = new Set(["北京", "上海", "天津", "重庆"]);

/** 单次级联下拉等待"出现可用项"的轮询上限（ms）。 */
export const SCENIC_SEARCH_TIMEOUT_MS = 3_000;