import type { AppUpdateErrorCode } from "../../shared/contracts.js";

/**
 * 更新链路里可以预期的失败：既有分类码，也带上直接可读的中文说明，
 * 以及可选的原始技术细节。抛这个类型而不是裸 Error，是为了让渲染层
 * 不必解析英文异常文本。
 */
export class AppUpdateFailure extends Error {
  readonly code: AppUpdateErrorCode;
  readonly detail?: string;

  constructor(code: AppUpdateErrorCode, message: string, detail?: string) {
    super(message);
    this.name = "AppUpdateFailure";
    this.code = code;
    this.detail = detail;
  }
}

export interface AppUpdateFailureInfo {
  code: AppUpdateErrorCode;
  message: string;
  detail?: string;
}

const NETWORK_PATTERN = /ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNREFUSED|ECONNRESET|EPIPE|fetch failed|socket hang up|network|timeout/i;
const SEMVER_PATTERN = /ERR_UPDATER_INVALID_VERSION|does not have a valid semver/i;

/**
 * 把任意异常翻译成「原因分类 + 中文说明 + 可选技术细节」。
 * 兜底分支保留原文，但放进 detail，界面主文案始终是可读中文。
 */
export function describeUpdateFailure(error: unknown): AppUpdateFailureInfo {
  if (error instanceof AppUpdateFailure) {
    return { code: error.code, message: error.message, detail: error.detail };
  }
  const detail = error instanceof Error ? error.message : String(error);
  if (NETWORK_PATTERN.test(detail)) {
    return {
      code: "feed_unreachable",
      message: "连接更新服务器失败，请确认本机网络可以访问更新源后重试。",
      detail,
    };
  }
  if (SEMVER_PATTERN.test(detail)) {
    return {
      code: "manifest_invalid",
      message: "更新源上的清单缺少有效版本号，服务器上的更新清单可能未更新或已损坏。",
      detail,
    };
  }
  if (/\b404\b|not found/i.test(detail)) {
    return {
      code: "feed_missing",
      message: "更新源上找不到对应的更新文件，服务器可能还没有上传这个版本。",
      detail,
    };
  }
  return {
    code: "unknown",
    message: "更新失败，请稍后重试；若持续失败，请把诊断信息发给维护人员。",
    detail,
  };
}
