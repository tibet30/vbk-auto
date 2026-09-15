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
