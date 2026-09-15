/** 操作日志与运行时日志捕获契约。 */

/* ============================================================
 * 操作日志：浏览器自动化每一次点击、输入、校验、跳转都留痕，
 * 供运营事后定位失败原因、复跑某一步或回查现场。
 * ============================================================ */

export type OperationType =
  | "runtime"
  | "click"
  | "input"
  | "navigate"
  | "verify"
  | "screenshot"
  | "wait"
  | "select"
  | "upload";

export type OperationStatus = "succeeded" | "failed" | "skipped" | "running";
export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogSource = "main" | "renderer" | "automation" | "system";

export interface OperationLogEntry {
  id: string;
  /** 关联到的本地产品 ID；undefined 表示全局操作（如登录态维护）。 */
  localProductId?: string;
  /** 关联到的产品名称，方便在不切产品时识别。 */
  productName?: string;
  type: OperationType;
  /** 操作可读的名称，如「点击确认删除」「输入产品名称」。 */
  name: string;
  status: OperationStatus;
  /** 自动化阶段，如 basicInfo / saleControl。 */
  stage?: string;
  /** 该阶段下的子步骤，如 supplier / productName。 */
  phase?: string;
  /** 第几次尝试，1 起。 */
  attempt: number;
  startedAt: string;
  durationMs: number;
  /** 失败或跳过时的说明；成功留空。 */
  message?: string;
  /** 操作目标的 VBK 选择器/字段路径，便于运营定位。 */
  target?: string;
  /** 日志严重级别；历史操作记录缺省按 info 展示。 */
  level?: LogLevel;
  /** 日志产生位置，帮助区分主进程、页面和自动化。 */
  source?: LogSource;
  /** 从 `[planning]` 这类前缀提取出的模块名。 */
  module?: string;
  /** 已脱敏的结构化上下文；仅用于平台详情与安全导出。 */
  context?: Record<string, unknown>;
}

export interface OperationLogSummary {
  total: number;
  succeeded: number;
  failed: number;
  skipped: number;
  /** 当前正在进行的条目数（status === 'running'），便于在标题里表达"还在跑"。 */
  running: number;
  debug: number;
  info: number;
  warn: number;
  error: number;
}

export interface OperationLogQuery {
  query?: string;
  status?: OperationStatus | "all";
  type?: OperationType | "all";
  stage?: string | "all";
  localProductId?: string;
  level?: LogLevel | "all";
  source?: LogSource | "all";
  /** 上限条数；缺省走 OPERATION_LOG_CAP。 */
  limit?: number;
}

export interface OperationLogPage {
  summary: OperationLogSummary;
  entries: OperationLogEntry[];
  /** 用于过滤下拉的可用阶段列表。 */
  stages: string[];
  sources: LogSource[];
  /** 刷新时间戳（ISO），方便头部显示「最近更新于…」并避免重复拉取。 */
  refreshedAt: string;
}

export interface RuntimeLogCaptureInput {
  level: LogLevel;
  source: LogSource;
  occurredAt: string;
  message: string;
  module?: string;
  context?: Record<string, unknown>;
}

export interface OperationLogExportResult {
  canceled: boolean;
  count: number;
  path?: string;
}
