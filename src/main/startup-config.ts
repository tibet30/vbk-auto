/**
 * 启动期进程级配置
 * ==================
 *
 * 把 main.ts 顶部这一组「必须在任何其它逻辑之前就生效」的关注点集中放在本文件：
 *   - appendSwitch 抑制 Chromium 内部 noise / 关掉 ServiceWorker feature
 *   - 随机分配回环 CDP 端口（避开固定 9222）
 *   - isDev 判定（影响 DevTools / 临时路径开关）
 *   - logPoiManualIpc：开发模式下才会落地的 POI 手动操作日志 helper
 *   - defaultMiniMaxModel：从环境变量读 MiniMax 模型名
 *   - unhandledRejection：Playwright 与浏览器对话框并发时会偶发
 *     `Page.handleJavaScriptDialog: No dialog is showing`，这种已知 race 仅 warn。
 *
 * 这些配置需要在 `app.whenReady()` 之前生效，因此必须放在 main.ts 顶层、
 * 在 import 之后第一时间执行。
 */
import { app } from "electron";

import { logError, logLog, logWarn } from "../shared/log-timestamp.js";

/** 当前是否为开发模式（未打包），用于开关 DevTools / 临时文件路径。 */
export const isDev = !app.isPackaged;

/**
 * 随机生成回环调试端口（9300-9899）并仅监听 127.0.0.1：
 * 避免固定 9222 端口被本机其它进程劫持已登录会话。
 */
export const debuggingPort = String(9300 + Math.floor(Math.random() * 600));

/** MiniMax 默认 model：环境变量优先，否则用产品默认的「MiniMax-M3」。 */
export const defaultMiniMaxModel = process.env.MINIMAX_MODEL?.trim() || "MiniMax-M3";

/** 仅 dev 模式下输出 POI 手动操作的诊断日志。 */
export function logPoiManualIpc(event: string, context: Record<string, unknown>): void {
  if (!isDev) return;
  logLog("[poi.manual]", event, { stage: event, ...context });
}

function formatProcessRejection(reason: unknown): { message: string; stack?: string } {
  if (reason instanceof Error) return { message: reason.message, stack: reason.stack };
  return { message: String(reason) };
}

function isPlaywrightNoDialogShowingRejection(reason: unknown): boolean {
  const { message, stack } = formatProcessRejection(reason);
  return /Page\.handleJavaScriptDialog[\s\S]*No dialog is showing/.test(`${message}\n${stack ?? ""}`);
}

/** 必须在 `app.whenReady()` 之前调用，把所有 command-line switch 都装好。 */
export function applyStartupCommandLineSwitches(): void {
  // 自动化通过 CDP 驱动内嵌的 VBK 页面，端口必须开着；端口随机取，仅监听回环。
  app.commandLine.appendSwitch("remote-debugging-port", debuggingPort);
  app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");
  // 抑制 Chromium 内部 noise（service_worker/quota/stun 等），只显示 WARNING 及以上。
  app.commandLine.appendSwitch("log-level", "2");
  // 关闭 ServiceWorker：renderer 不使用 SW（仅用 localStorage），defense-in-depth 避免
  // 后续 Chromium 内部误注册 SW 后再生成新的 ServiceWorker DB。
  app.commandLine.appendSwitch("disable-features", "ServiceWorker");
}

/** 安装 process 级 unhandledRejection 监听，已知 Playwright race 仅 warn。 */
export function installProcessErrorHandlers(): void {
  process.on("unhandledRejection", (reason) => {
    const formatted = formatProcessRejection(reason);
    if (isPlaywrightNoDialogShowingRejection(reason)) {
      logWarn("[playwright] ignored native JS dialog race", { message: formatted.message });
      return;
    }
    logError("[process] unhandledRejection", formatted);
  });
}