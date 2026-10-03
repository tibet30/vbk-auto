import type { DailyTransport, VbkDailyUseCar } from "../../../../shared/product-form.js";
import type { StationCandidate } from "./station-search.js";

/**
 * 输入：项目侧行程 + operations。
 *   - day 字段：{ day, title, spots, description, hotel, meals, mealDescriptions? }
 *   - spots 字段：{ name, poiName?, poiId?, province?, city?, district? }（poiId 是 VBK 系统 POI 唯一 ID）
 */
export interface ProductItineraryDay {
  day: number;
  title: string;
  spots?: Array<{
    name: string;
    poiName?: string | null;
    poiId?: number | null;
    province?: string | null;
    city?: string | null;
    district?: string | null;
    poiType?: { key: number; name: string } | null;
    ticketType?: { key: number; name: string } | null;
    poiData?: Record<string, unknown>;
    /** 景点必须使用 attraction；明确自由活动与其他服务不进入 POI 链路。 */
    kind?: "attraction" | "free" | "other";
    description?: string;
    /** 规划层已按时段排好顺序；缺省时按 spots 顺序均分上午/下午。 */
    timeOfDay?: "morning" | "afternoon";
    /** 同一时段内的景点关系：and=全部参观；or=多选一。缺省按 and 录入。 */
    relation?: "and" | "or";
  }>;
  description: string;
  hotel: string;
  /** 携程检索得到的同晚候选（最多五家）；写入行程时取前三家形成“或”酒店节点。 */
  hotelCandidates?: Array<{ hotelName: string }>;
  meals: string;
  mealDescriptions?: string[];
  activities?: Array<{
    time: string;
    title: string;
    detail: string;
    type?: "transport" | "visit" | "meal" | "hotel" | "free" | "other";
    durationMinutes?: number;
    source?: "user" | "ai";
  }>;
}

export interface ProductOperations {
  hotelTier?: string;
  pickupCity?: string;
  transport?: DailyTransport;
  reusePickupForDropoff?: boolean;
  mealsIncluded?: boolean;
}

/**
 * 输出：VBK 协议 detail.tourInfo.tourDailyDescriptions。
 * 这里只声明外层结构，便于单测做类型断言；具体每个 info 的形状由 builder 构造。
 */
export interface VbkTourDailyDescription {
  tourDailyDescriptionId: number | null;
  orderDay: number;
  dailyDescription: string;
  useCar: VbkDailyUseCar;
  tourDailyLocations: Array<Record<string, unknown>>;
  tourDailyInfos: Array<Record<string, unknown>>;
  seaCruise: boolean;
  subDesc: string;
  dailyHighlights: unknown[];
}

/** 接送站（机场/火车）解析结果，由 station-search 返回。 */
export interface ResolvedStations {
  /** 接机机场（pickup 当天 airport）；不存在时为 null。 */
  pickupAir?: StationCandidate | null;
  /** 接机火车站；不存在时为 null。 */
  pickupTrain?: StationCandidate | null;
  /** 送机机场；不存在时为 null。 */
  dropoffAir?: StationCandidate | null;
  /** 送机火车站；不存在时为 null。 */
  dropoffTrain?: StationCandidate | null;
  /** 是否使用了多选 fallback（如 AI 选中）；用于日志诊断。 */
  source?: "exact" | "single" | "fallback-first" | "primary-airport" | "ai";
}

/**
 * 单天回读期望（由 buildReadbackExpectations 生成）。verifyItineraryReadback
 * 会按 orderDay 顺序逐项比对，错误信息含「第 N 天 / 字段 / 期望 / 实际」。
 */
export interface ReadbackDayExpectation {
  orderDay: number;
  title: string;
  /** 景点 POI 列表（顺序敏感）。 */
  pois: Array<{ poiId: number; poiName: string; description?: string; suffixKey?: number }>;
  /** 当日餐饮（顺序敏感：首日午/晚；中间日早/午/晚；尾日早/午）。 */
  meals: Array<{
    key: "B" | "L" | "S";
    description: string;
    mealsIncluded: boolean;
  }>;
  /** 酒店节点（无酒店时为空数组）。 */
  hotels: Array<{ hotelName: string; hotelTier?: string }>;
  /** 每天标题下的“当天用车”。 */
  useCar: VbkDailyUseCar;
  /** 非景点卡片逐项回读，free/other 的模块类型与顺序均不可混用。 */
  activities: Array<{ kind: "free" | "other"; description: string; time: string; durationMinutes?: number }>;
  /** 剔除餐饮、酒店、接送后的业务卡片顺序；用于防止平台把其他活动挪到日末。 */
  timeline: Array<{ kind: "attraction"; pois: Array<{ poiId: number; poiName: string }> } | { kind: "free" | "other"; description: string; time: string; durationMinutes?: number }>;
  /** 服务时间（其他节点写入 startOnBoardTime / stopOnBoardTime）。 */
  serviceTime: { startTime: string; endTime: string };
}

export interface ReadbackExpectations {
  days: ReadbackDayExpectation[];
  /** 接送站（首日接机 / 接站；末日送机 / 送站）。 */
  pickup: { airport?: { code: string; name: string } | null; train?: { code: string; name: string } | null };
  dropoff: { airport?: { code: string; name: string } | null; train?: { code: string; name: string } | null };
  /** 是否有酒店业务（业务要求 → 每天回读必须有酒店节点）。 */
  requireHotels: boolean;
}

