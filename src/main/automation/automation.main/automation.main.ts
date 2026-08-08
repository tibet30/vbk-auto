/**
 * automation.main 模块的统一 re-export：暴露 AutomationCancelledError 与 DraftAutomation。
 * 实际实现见 ./automation.main.class.ts，本文件仅作为外部唯一入口。
 */

export { AutomationCancelledError } from "./automation.main.errors.js";
export { DraftAutomation } from "./automation.main.class.js";
