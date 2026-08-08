/**
 * 历史 product_json 兼容迁移。
 *
 * 早期版本（V0.x）生成的 product_json 字段集与现行 schema 略有差异：
 *   - 没有 `sales` / `operations` / `itinerary` 段；
 *   - `basicInfo.meetingCity` 可能缺失（用 destinationCity 兜底）；
 *   - `logs` / `messages` / `researchTasks` 项目字段不存在（默认为 undefined）。
 *
 * 这份模块只做"读到内存时"的归一化，**不**回写数据库，也不强行把整张
 * 库的 project_json 一次性升级；写到数据库时由 ai / 项目 UI 自行决定
 * 是否用 patch 触发一次 updateProduct 持久化。
 *
 * 归一化原则：
 *   - 任何字段缺失都用 DEFAULT_PRODUCT 兜底，保证前端拿到的是 minimum
 *     valid product 形态；
 *   - 字符串字段强转并 trim，map/list 字段缺失返回空 map/list；
 *   - 不抛错。解析失败时返回兜底，避免某个脏 row 让整个 getProject 失效。
 */

import type { ProjectDetail } from "../../../shared/contracts.js";

/**
 * 最小可渲染 product 兜底：必须满足 schema 验证（看 schema-functions.ts 的
 * DEFAULT_PRODUCT），并保证新建项目也能通过 parseProduct 校验。
 */
const DEFAULT_PRODUCT = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  sales: { productType: "domesticShort", productForm: "privateTour", splitGroup: false },
  basicInfo: {
    supplierProductName: "",
    supplierProductCode: "",
    days: 0,
    nights: 0,
    meetingCity: "",
    destinationCity: "",
  },
  operations: { hotelSource: "nonPlatform", hotelTier: "threeStar", mealsIncluded: false },
  itinerary: [],
  ...overrides,
});

/**
 * 把数据库里的 product_json 字符串解析为统一形态。
 *  - 解析失败 → 兜底；
 *  - 任何字段缺失 → 局部兜底；
 *  - 返回类型是 ProjectDetail["product"]，但运行时倾向于 Record<string, unknown>。
 */
export function parseAndNormalizeProductJson(raw: string | null | undefined): ProjectDetail["product"] {
  if (!raw) return DEFAULT_PRODUCT() as ProjectDetail["product"];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_PRODUCT() as ProjectDetail["product"];
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return DEFAULT_PRODUCT() as ProjectDetail["product"];
  }
  const product = parsed as Record<string, unknown>;
  const base = DEFAULT_PRODUCT();
  // 复写：保留 DB 已有字段，只对缺失字段补兜底。
  for (const [key, value] of Object.entries(base)) {
    if (product[key] === undefined) product[key] = value;
  }
  // 旧字段兼容：basicInfo.meetingCity 缺失时用 destinationCity 兜底。
  const basicInfo = product.basicInfo as Record<string, unknown> | undefined;
  if (basicInfo && typeof basicInfo === "object") {
    if (!basicInfo.meetingCity && basicInfo.destinationCity) {
      basicInfo.meetingCity = basicInfo.destinationCity;
    }
  }
  return product as ProjectDetail["product"];
}
