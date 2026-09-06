/**
 * 线路及交通子产品的持久化契约。
 *
 * 新产品默认尝试规划飞机、火车两个往返子产品；地点和站点必须由已完成的行程
 * 及当前 BrowserView 会话的 VBK 候选接口确认。某种交通没有可确认站点时，
 * 只跳过该种子产品，绝不从创建表单猜测或创建后再失败。
 */

export const TRAFFIC_LINE_VARIANTS = ["flightRoundTrip", "trainRoundTrip"] as const;

export type TrafficLineVariant = (typeof TRAFFIC_LINE_VARIANTS)[number];

export const TRAFFIC_LINE_LABELS: Readonly<Record<TrafficLineVariant, string>> = {
  flightRoundTrip: "飞机往返",
  trainRoundTrip: "火车往返",
};

export interface TrafficLineConfig {
  /** 仅兼容历史禁用记录；所有新产品都固定为 true。 */
  enabled: boolean;
  /** 新产品固定包含两种往返；历史记录可用于可恢复重试。 */
  variants: TrafficLineVariant[];
}

export const DEFAULT_TRAFFIC_LINE_CONFIG: TrafficLineConfig = {
  enabled: true,
  variants: [...TRAFFIC_LINE_VARIANTS],
};

/** 已由行程 POI 城市和当前会话候选接口确认的子产品交通地点。 */
export interface TrafficLineStation {
  /** 行程/接送接口使用的稳定 locationCode 或机场三字码。 */
  code: string;
  name: string;
  /** 资源段选择控件使用的当前平台 key；火车为 stationNo。 */
  resourceKey?: string;
}

export interface TrafficLineEndpointPlan {
  arrivalCity: string;
  departureCity: string;
  flight?: { arrival: TrafficLineStation; departure: TrafficLineStation };
  train?: { arrival: TrafficLineStation; departure: TrafficLineStation };
  resolvedAt: string;
}

export const TRAFFIC_LINE_CHILD_STAGES = [
  "planned",
  "stationsResolved",
  "childCreated",
  "presentationCopied",
  "resourcesSaved",
  "itinerarySaved",
  "clausesSaved",
  "activated",
  "finalReadback",
] as const;

export type TrafficLineChildStage = (typeof TRAFFIC_LINE_CHILD_STAGES)[number];

export interface TrafficLineChildProgress {
  variant: TrafficLineVariant;
  lineDescription: string;
  childProductId?: string;
  completedStages: TrafficLineChildStage[];
  verified: boolean;
  /** 平台已明确确认该交通方式没有可售资源；保留子产品记录但不再自动重试。 */
  skipped?: boolean;
  failedStage?: TrafficLineChildStage;
  failureReason?: string;
}

/** 仅写入可恢复、已回读的事实；不保存 Cookie、CID 或原始 VBK payload。 */
export interface TrafficLineWorkflowProgress {
  endpointPlan?: TrafficLineEndpointPlan;
  /** 录入前的会话查询未确认该交通方式可用；下次运行会重新查询。 */
  unavailableVariants?: Partial<Record<TrafficLineVariant, string>>;
  /** 正式班期校验已证实无可用出发城市的火车站码；恢复时禁止循环选回。 */
  rejectedTrainStationCodes?: string[];
  children: TrafficLineChildProgress[];
  /** 首个子节点开始前（例如站点解析失败）也要保留可见的安全重试原因。 */
  failureReason?: string;
  verifiedAt?: string;
}

export function trafficLineLabel(variant: TrafficLineVariant): string {
  return TRAFFIC_LINE_LABELS[variant];
}

export function isTrafficLineVariant(value: unknown): value is TrafficLineVariant {
  return typeof value === "string" && (TRAFFIC_LINE_VARIANTS as readonly string[]).includes(value);
}

/**
 * 归一化 VBK 当前/历史线路名。历史扩展曾写入「高铁往返」，平台当前统一
 * 视作「火车往返」，因此幂等匹配必须把它们折叠到同一 variant。
 */
export function normaliseTrafficLineVariant(value: unknown): TrafficLineVariant | null {
  if (typeof value !== "string") return null;
  const compact = value.replace(/\s+/g, "");
  if (["flightRoundTrip", "飞机往返"].includes(compact)) return "flightRoundTrip";
  if (["trainRoundTrip", "火车往返", "高铁往返"].includes(compact)) return "trainRoundTrip";
  return null;
}

export function normaliseTrafficLineConfig(value: unknown): TrafficLineConfig | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const variants = Array.isArray(raw.variants)
    ? raw.variants.flatMap((item) => {
      const variant = normaliseTrafficLineVariant(item);
      return variant ? [variant] : [];
    }).filter((variant, index, values) => values.indexOf(variant) === index)
    : [];
  return { enabled: raw.enabled !== false, variants: variants.length ? variants : [...TRAFFIC_LINE_VARIANTS] };
}
