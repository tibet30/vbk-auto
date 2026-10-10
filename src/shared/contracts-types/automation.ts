/**
 * AutomationRun：单次自动化跑的状态机快照（checkpoint）。
 *
 * phases / logs / screenshot 是单跑的内部字段；recovery 单独抬出
 * advisor + phase 维度；trafficLine 只放已由远端回读确认的子产品检查点。
 */

import type { TaskStatus } from "./conversation.js";
import type { PhaseRecovery } from "./advisor.js";
import type { TrafficLineWorkflowProgress } from "../contracts-traffic-line.js";

export interface AutomationRun {
  id: string;
  /** 运行检查点时间；远端精简快照不含日志时仍可判断运行状态的新旧。 */
  updatedAt?: string;
  status: TaskStatus;
  currentPhase?: string;
  phases: Array<{ phase: string; status: "pending" | "running" | "completed" | "failed" }>;
  logs: Array<{ at: string; message: string; level: "info" | "warning" | "error" }>;
  screenshot?: string;
  recovery?: { phases: Record<string, PhaseRecovery> };
  /** 线路及交通仅保存已由远端回读确认的子产品检查点。 */
  trafficLine?: TrafficLineWorkflowProgress;
}