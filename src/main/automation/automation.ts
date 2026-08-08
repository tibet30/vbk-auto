/**
 * 「自动化」聚合 re-export：把 DraftAutomation / AutomationCancelledError 暴露给主进程 IPC layer。
 * 仅一层 re-export，避免外部依赖直接耦合 automation.main 子目录。
 */

export * from "./automation.main/automation.main.js";
