/**
 * 线路及交通子产品的持久化契约。
 *
 * 只有产品明确售卖飞机或火车往返时，才规划对应的交通子产品；地点和站点必须
 * 由已完成的行程及当前 BrowserView 会话的 VBK 候选接口确认。接站、送站和
 * 当地用车属于地接行程，绝不能被推断成大交通往返。
 */

export const TRAFFIC_LINE_VARIANTS = ["flightRoundTrip", "trainRoundTrip"] as const;

export type TrafficLineVariant = (typeof TRAFFIC_LINE_VARIANTS)[number];

export const TRAFFIC_LINE_LABELS: Readonly<Record<TrafficLineVariant, string>> = {
  flightRoundTrip: "飞机往返",
  trainRoundTrip: "火车往返",
};

export interface TrafficLineConfig {
  /** 仅在产品明确包含可售大交通时启用。 */
  enabled: boolean;
  /** 已明确售卖的往返类型；空数组仅可与 disabled 配置一起出现。 */
  variants: TrafficLineVariant[];
  /**
   * 运营或用户明确指定的抵达端点城市。未填写时才回退产品目的地；不能从
   * 首日景点、接站城市或 POI 推断。
   */
  arrivalCity?: string;
  /**
   * 运营或用户明确指定的返程端点城市。未填写时才回退产品目的地；不能从
   * 末日景点、送站城市或 POI 推断。
   */
  departureCity?: string;
  /**
   * 最近一次在当前 VBK 会话中完成的只读端点核验。
   *
   * 这不是平台已写入的证明：它只让审查区准确展示哪些交通方式与站点已经
   * 筛选确认、可在下一步录入。正式子产品的创建与最终回读仍记录在
   * automation.trafficLine 中。
   */
  availability?: TrafficLineEndpointAvailability;
}

export const DEFAULT_TRAFFIC_LINE_CONFIG: TrafficLineConfig = {
  enabled: false,
  variants: [],
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

/** 当前会话对首末日城市大交通端点的只读核验结果。 */
export interface TrafficLineEndpointAvailability {
  endpointPlan: TrafficLineEndpointPlan;
  availableVariants: TrafficLineVariant[];
  unavailableVariants: Partial<Record<TrafficLineVariant, string>>;
  /** 母产品创建前，对热门出发城市和代表日期执行的携程双向班次预检。 */
  scheduleChecks?: Partial<Record<TrafficLineVariant, TrafficLineScheduleCheck>>;
}

export interface TrafficLineScheduleCheck {
  status: "available" | "unavailable" | "unconfirmed";
  checkedDates: string[];
  checkedCityCount: number;
  matchedOriginCity?: string;
  reason?: string;
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
  /** 最近一次班期校验实际提交的代表性日期数量；缺失表示旧版全量校验。 */
  validationScheduleCount?: number;
  /** 最近一次校验实际提交的 VBK 热门出发城市数量。 */
  validationDepartureCityCount?: number;
  /** 远端写入前持久化，避免进程中断后无法判断是否已经提交。 */
  validationSubmittedAt?: string;
  /** 旧版全量校验长期未收口时，只允许迁移为代表性班期一次。 */
  validationRecoveryResubmittedAt?: string;
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
  // 缺失配置、空对象或没有可识别交通方式，均不代表产品出售大交通。历史记录
  // 若已保存任一明确变体，仍可继续恢复；只有 `enabled: true` + 空变体保留为
  // 上游配置错误，交给自动化契约明确拦截而不是静默猜测飞机/火车。
  return {
    enabled: raw.enabled === true || (raw.enabled !== false && variants.length > 0),
    variants,
    ...(normaliseTrafficLineCity(raw.arrivalCity) ? { arrivalCity: normaliseTrafficLineCity(raw.arrivalCity) } : {}),
    ...(normaliseTrafficLineCity(raw.departureCity) ? { departureCity: normaliseTrafficLineCity(raw.departureCity) } : {}),
    ...(normaliseTrafficLineAvailability(raw.availability) ? { availability: normaliseTrafficLineAvailability(raw.availability) } : {}),
  };
}

/** 仅保留审查卡渲染所需的、带稳定端点码的核验事实。 */
function normaliseTrafficLineAvailability(value: unknown): TrafficLineEndpointAvailability | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const endpointPlan = raw.endpointPlan;
  if (!endpointPlan || typeof endpointPlan !== "object" || Array.isArray(endpointPlan)) return undefined;
  const plan = endpointPlan as Record<string, unknown>;
  const arrivalCity = normaliseTrafficLineCity(plan.arrivalCity);
  const departureCity = normaliseTrafficLineCity(plan.departureCity);
  const resolvedAt = typeof plan.resolvedAt === "string" ? plan.resolvedAt : "";
  if (!arrivalCity || !departureCity || !resolvedAt) return undefined;
  const availableVariants = Array.isArray(raw.availableVariants)
    ? raw.availableVariants.flatMap((item) => {
      const variant = normaliseTrafficLineVariant(item);
      return variant ? [variant] : [];
    }).filter((variant, index, variants) => variants.indexOf(variant) === index)
    : [];
  const route = (kind: "flight" | "train") => {
    const value = plan[kind];
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const item = value as Record<string, unknown>;
    const station = (endpoint: unknown): TrafficLineStation | undefined => {
      if (!endpoint || typeof endpoint !== "object" || Array.isArray(endpoint)) return undefined;
      const rawStation = endpoint as Record<string, unknown>;
      const code = typeof rawStation.code === "string" ? rawStation.code.trim() : "";
      const name = typeof rawStation.name === "string" ? rawStation.name.trim() : "";
      if (!code || !name) return undefined;
      const resourceKey = typeof rawStation.resourceKey === "string" ? rawStation.resourceKey.trim() : "";
      return { code, name, ...(resourceKey ? { resourceKey } : {}) };
    };
    const arrival = station(item.arrival);
    const departure = station(item.departure);
    return arrival && departure ? { arrival, departure } : undefined;
  };
  const flight = route("flight");
  const train = route("train");
  const confirmed = availableVariants.filter((variant) => variant === "flightRoundTrip" ? Boolean(flight) : Boolean(train));
  const unavailableRaw = raw.unavailableVariants && typeof raw.unavailableVariants === "object" && !Array.isArray(raw.unavailableVariants)
    ? raw.unavailableVariants as Record<string, unknown>
    : {};
  const unavailableVariants = Object.fromEntries(
    TRAFFIC_LINE_VARIANTS.flatMap((variant) => typeof unavailableRaw[variant] === "string" ? [[variant, unavailableRaw[variant]]] : []),
  ) as Partial<Record<TrafficLineVariant, string>>;
  const checksRaw = raw.scheduleChecks && typeof raw.scheduleChecks === "object" && !Array.isArray(raw.scheduleChecks)
    ? raw.scheduleChecks as Record<string, unknown>
    : {};
  const scheduleChecks = Object.fromEntries(TRAFFIC_LINE_VARIANTS.flatMap((variant) => {
    const value = checksRaw[variant];
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const check = value as Record<string, unknown>;
    if (!["available", "unavailable", "unconfirmed"].includes(String(check.status))) return [];
    const checkedDates = Array.isArray(check.checkedDates)
      ? check.checkedDates.filter((date): date is string => typeof date === "string" && Boolean(date.trim()))
      : [];
    const checkedCityCount = typeof check.checkedCityCount === "number" && Number.isFinite(check.checkedCityCount)
      ? Math.max(0, Math.floor(check.checkedCityCount))
      : 0;
    const matchedOriginCity = normaliseTrafficLineCity(check.matchedOriginCity);
    const reason = typeof check.reason === "string" ? check.reason.trim() : "";
    return [[variant, {
      status: check.status as TrafficLineScheduleCheck["status"], checkedDates, checkedCityCount,
      ...(matchedOriginCity ? { matchedOriginCity } : {}), ...(reason ? { reason } : {}),
    }]];
  })) as Partial<Record<TrafficLineVariant, TrafficLineScheduleCheck>>;
  if (!confirmed.length && !Object.keys(unavailableVariants).length && !Object.keys(scheduleChecks).length) return undefined;
  return {
    endpointPlan: { arrivalCity, departureCity, resolvedAt, ...(flight ? { flight } : {}), ...(train ? { train } : {}) },
    availableVariants: confirmed,
    unavailableVariants,
    ...(Object.keys(scheduleChecks).length ? { scheduleChecks } : {}),
  };
}

function normaliseTrafficLineCity(value: unknown): string {
  return typeof value === "string" ? value.trim().replace(/\s+/g, "").replace(/市$/, "") : "";
}
