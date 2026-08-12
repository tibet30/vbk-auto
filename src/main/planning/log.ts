/**
 * 规划子系统统一日志：所有 console 输出都走这里，便于：
 *   - 主进程日志在终端 / dev tools 主进程面板可读；
 *   - 失败阶段带 stage / attempt / projectId / provider 等结构化字段，
 *     方便运营 / 工程师排查「继续规划还是报错」类用户报告；
 *   - 日志前缀一致，便于 grep / 过滤。
 *
 * 这里**不会**写入持久化 lastError：lastError 由 stage-runner / orchestrator
 * 直接构造；本模块只做 console 输出，不做副作用。
 *
 * 安全：
 *   - message 字段允许为任意字符串，但本文件使用方应避免在日志里写密钥 /
 *     ciphertext / 长 base64；如果上游不确定，应当先用 redactSensitiveMessage。
 */

import { redactSensitiveMessage } from "./preflight-failure.js";
import { logInfo, logWarn } from "../../shared/log-timestamp.js";

/** logger options */
export interface PlanningLogContext {
  projectId?: string;
  stage?: string;
  attempt?: number;
  providerLabel?: string;
  /** 额外自由字段；调用方负责 redact。 */
  [extra: string]: unknown;
}

const PREFIX = "[planning]";

function safe(value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: redactSensitiveMessage(value.message ?? ""), stack: value.stack };
  }
  if (typeof value === "string") return redactSensitiveMessage(value);
  return value;
}

function fmt(context: PlanningLogContext | undefined): string {
  if (!context) return "";
  const parts: string[] = [];
  if (context.projectId) parts.push(`project=${context.projectId}`);
  if (context.stage) parts.push(`stage=${context.stage}`);
  if (typeof context.attempt === "number") parts.push(`attempt=${context.attempt}`);
  if (context.providerLabel) parts.push(`provider=${context.providerLabel}`);
  for (const [key, value] of Object.entries(context)) {
    if (key === "projectId" || key === "stage" || key === "attempt" || key === "providerLabel") continue;
    parts.push(`${key}=${typeof value === "string" ? value : JSON.stringify(safe(value))}`);
  }
  return parts.length ? ` ${parts.join(" ")}` : "";
}

/** 进入 runPlan / 续跑。 */
export function logRunStart(message: string, context?: PlanningLogContext): void {
  logInfo(`${PREFIX} run.start ${message}${fmt(context)}`);
}

/** runPlan 退出 + 最终态。 */
export function logRunEnd(message: string, context?: PlanningLogContext): void {
  logInfo(`${PREFIX} run.end ${message}${fmt(context)}`);
}

/** 单阶段开始执行。 */
export function logStageStart(message: string, context?: PlanningLogContext): void {
  logInfo(`${PREFIX} stage.start ${message}${fmt(context)}`);
}

/** 单阶段完成。 */
export function logStageEnd(message: string, context?: PlanningLogContext): void {
  logInfo(`${PREFIX} stage.end ${message}${fmt(context)}`);
}

/** 单次 AI attempt 错误（planner 抛错或输出空）。 */
export function logAttemptError(message: string, context?: PlanningLogContext): void {
  logWarn(`${PREFIX} attempt.error ${message}${fmt(context)}`);
}

/** 续跑未取得进展：当前阶段重复失败，但状态机不会自己跳到下一阶段。 */
export function logNoProgress(message: string, context?: PlanningLogContext): void {
  logWarn(`${PREFIX} no_progress ${message}${fmt(context)}`);
}
