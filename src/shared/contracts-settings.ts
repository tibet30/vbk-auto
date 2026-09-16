/** AI provider 设置与连接探测契约。 */
export type AiProvider = "minimax" | "deepseek";

export interface Settings {
  aiProvider: AiProvider;
  minimaxBaseUrl: string;
  minimaxModel: string;
  deepseekBaseUrl: string;
  deepseekModel: string;
  hasMiniMaxKey: boolean;
  hasDeepSeekKey: boolean;
  /** AI 等待用户处理或执行失败时，是否发送 macOS 系统通知。默认开启。 */
  systemNotificationsEnabled: boolean;
  /** 当前运行环境是否支持 Electron 原生系统通知。 */
  systemNotificationsSupported: boolean;
  dataPath: string;
}

export interface SystemNotificationResult {
  shown: boolean;
  message: string;
}

export type AppUpdateStatus =
  | "idle"
  | "unsupported"
  | "checking"
  | "available"
  | "not_available"
  | "downloading"
  | "downloaded"
  | "error";

/**
 * 更新失败的可判定原因。渲染层按这个分类给出针对性的中文说明与修复建议，
 * 而不是把底层异常原文直接摊在界面上。
 */
export type AppUpdateErrorCode =
  | "unsupported"
  | "feed_missing"
  | "feed_unreachable"
  | "manifest_invalid"
  | "installer_missing"
  | "download_failed"
  | "unknown";

export interface AppUpdateProgress {
  percent: number;
  transferred: number;
  total: number;
  bytesPerSecond: number;
}

export interface AppUpdateState {
  currentVersion: string;
  platform: string;
  supported: boolean;
  feedUrl: string;
  status: AppUpdateStatus;
  updateAvailable: boolean;
  availableVersion?: string;
  releaseDate?: string;
  /** 面向用户的中文失败说明；成功时为空。 */
  errorMessage?: string;
  downloaded: boolean;
  installerPath?: string;
  progress?: AppUpdateProgress;
  /** 最近一次检查完成时间（ISO 字符串），成功与失败都会刷新。 */
  checkedAt?: string;
  /** 失败原因分类；成功时为空。 */
  errorCode?: AppUpdateErrorCode;
  /** 原始技术信息，只在「诊断信息」里折叠展示。 */
  errorDetail?: string;
}

export interface ConnectionTest {
  connected: boolean;
  message: string;
  provider: AiProvider;
  baseUrl: string;
  model: string;
  testedAt: string;
}

export interface AiConnectionTestInput {
  provider: AiProvider;
  baseUrl: string;
  model: string;
  apiKey?: string;
}

export interface AiModelListInput {
  provider: AiProvider;
  baseUrl: string;
  apiKey?: string;
}

export interface AiModelInfo {
  id: string;
  label: string;
  ownedBy?: string;
}

export interface AiModelListResult {
  models: AiModelInfo[];
  fetchedAt: string;
}
