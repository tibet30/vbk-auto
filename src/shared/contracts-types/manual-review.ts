/**
 * 运营人员在 review 面板上对单个字段的人工录入白名单。
 *
 * 用 discriminator (`field`) 拆分，每种 case 只覆盖一类字段，避免一个
 * 巨型 payload 把无关字段都拖进来。落地前 main 进程会再用 productSchema
 * 校验一次完整 product，保证无关字段保持原状。
 */

import type { ContactCardSelection } from "../contracts-vbk-account.js";
import type { ProductCover } from "../contracts-ctrip-cover.js";
import type { ItineraryActivityKind } from "../itinerary-activity-kind.js";

export type ManualReviewFieldInput =
  | { field: "pricing"; adult: number; child: number; minimumTravelers: number }
  | { field: "inventory"; startDate: string; endDate: string; dailyQuota: number }
  /** 副标题：写入 basicInfo.subtitle。 */
  | { field: "basicInfoSubtitle"; subtitle: string }
  /** 用车资源组人工复核只允许写全程预计总成本；真实资源组 ID / 名称由 VBK 匹配回填。 */
  | { field: "vehicleResource"; requestedTotalCost?: number | null }
  /** 每日行程 spot 的 VBK POI 手动补全：写入指定 spot 的 poiName / poiId，以及可选行政区。 */
  | {
    field: "itinerarySpotPoi";
    dayIndex: number;
    spotIndex: number;
    poiName: string;
    poiId: number;
    province?: string | null;
    city?: string | null;
    district?: string | null;
  }
  /** 手动切换有序行程条目的业务类型；切到非景点时必须清空既有 POI。 */
  | { field: "itinerarySpotKind"; dayIndex: number; spotIndex: number; kind: ItineraryActivityKind; description?: string }
  /** 每日行程 spot 手动删除：只移除指定 spot，并同步移除同名 visit 活动。 */
  | { field: "itinerarySpotRemove"; dayIndex: number; spotIndex: number }
  /**
   * 管家联系人：来自账号固定信息 (AccountFixedInfo.butlerName)，
   * 必须是合法的 ContactCardSelection（contactCardId / providerId / displayName）。
   * selection === null 表示清空（让自动化阶段走 VBK 默认逻辑）。
   */
  | { field: "butlerContact"; selection: ContactCardSelection | null }
  /**
   * 产品封面：ctripLibrary / manualUpload 两种形态。cover 形态由 cover.source
   * 决定：ctripLibrary 以 poi 与已选图片为准，description/minQuality 可选；manualUpload 额外含
   * fileId/originalName/mimeType/sizeBytes/uploadedAt，且 fileId 必须先经
   * main 端 cover:uploadManual 写入本地副本。
   *
   * 类型定义见 `contracts-ctrip-cover`：CtripLibraryCover / ManualUploadCover；
   * 它们与 `ProductCover` discriminated union 共享 source 字段，避免同时维护两套形状。
   */
  | {
      field: "productCover";
      cover: ProductCover;
    };

/**
 * AI 单字段重新生成允许的目标字段。当前 main 端只把这条 IPC 当作「未发布」
 * 占位（抛错），但 contracts 类型保留以便后续接入。
 */
export type AiRegenerateField = "subtitle" | "province" | "operationNotes" | "pricing" | "itinerary" | "sellingPoints";