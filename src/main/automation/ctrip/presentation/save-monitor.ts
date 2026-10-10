/**
 * 「产品图文」保存 monitor barrel。
 *
 * 本文件不持有具体实现：内容按"职责"拆分到 `./save-monitor/` 子目录。
 *
 * 子模块分工：
 *   - types.ts         SaveMonitorOutcome / InstallOptions / PresentationSensitiveWordsError；
 *   - constants.ts     路径常量 + 默认超时 + pathMatches helper；
 *   - settlement.ts    settle / onSaveResponse / applySaveOutcome / onSensitiveResponse / readBodyFields；
 *   - handlers.ts      request / response handler + onResponseSync 命名 wrapper；
 *   - timeout.ts       waitForSave + 兜底计时 + uninstall 工厂；
 *   - monitor.ts       install：把状态 + handler + waitForSave + uninstall 拼装起来。
 *
 * 调用方继续 `import {...} from "./save-monitor.js"`，符号由下面这些行再聚合出去。
 */

export type { SaveMonitorOutcome, InstallOptions } from "./save-monitor/types.js";
export { PresentationSensitiveWordsError } from "./save-monitor/types.js";

export {
  CHECK_SENSITIVE_WORD_PATH,
  DEFAULT_SAVE_TIMEOUT_MS,
  DEFAULT_SENSITIVE_WORD_TIMEOUT_MS,
  SAVE_DESCRIPTION_INFO_PATH,
} from "./save-monitor/constants.js";

export { installSaveMonitor } from "./save-monitor/monitor.js";