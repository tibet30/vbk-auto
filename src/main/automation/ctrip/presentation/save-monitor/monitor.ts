/**
 * 「产品图文」保存 monitor 实现：监听 page 的 request / response，捕捉
 * 官方 `/15638/savedescriptioninfo` + `/15638/checkSensitiveWord` 响应。
 *
 * 设计要点：
 *   - install() / uninstall() 严格成对；uninstall 必须清掉 request /
 *     response handler、清掉所有 setInterval timer、把 disposed 置 true；
 *   - 内部 settlement 通过 queueMicrotask 推迟到下一个微任务，避免
 *     response handler 在 waitForSave() 之前触发 reject 导致 unhandledRejection；
 *   - 缓存 cachedOutcome / cachedError，waitForSave() 之后调用也能正确结算；
 *   - 异常 ordering 兜底：save 响应到达 + pendingSensitive>0 时，若等待
 *     时间已超 sensitiveWordTimeoutMs，强制结算（防止「敏感词请求飞出
 *     但 response 永不回响」永久悬挂）。
 *
 * 子文件分工：
 *   - constants.ts   路径常量 + 默认超时；
 *   - types.ts       SaveMonitorOutcome / InstallOptions / PresentationSensitiveWordsError；
 *   - settlement.ts  settle / onSaveResponse / applySaveOutcome / onSensitiveResponse / readBodyFields；
 *   - handlers.ts    request / response handler + onResponseSync 命名 wrapper；
 *   - timeout.ts     waitForSave + 兜底计时 + uninstall；
 *   - monitor.ts（本文件）  install：把状态 + handler + waitForSave + uninstall 拼装起来。
 */

import type { InstallOptions } from "./types.js";
import { type MonitorState } from "./settlement.js";
import { handleRequest, onResponseSync } from "./handlers.js";
import { createUninstall, createWaitForSave } from "./timeout.js";

/**
 * 在 page 上挂监听 /15638/savedescriptioninfo 与 /15638/checkSensitiveWord，
 * 并返回 monitor 对象。调用方负责：
 *   - 在点击保存按钮之前 install；
 *   - 点击之后立即 waitForSave()；
 *   - 不管成功失败，都要在最外层 finally 调 uninstall()，避免污染下一次会话。
 */
export function installSaveMonitor(page: any, options: InstallOptions = {}) {
  const state: MonitorState = {
    settled: false,
    disposed: false,
    pendingSensitive: 0,
    pendingSaveResponse: null,
    savedResponse: null,
    sensitiveResponse: null,
    sensitiveRequestsSeen: 0,
    sensitiveResponsesSeen: 0,
    waitStartTs: null,
    cachedError: null,
    cachedOutcome: null,
    resolveWait: null,
    rejectWait: null,
  };
  const timers: Set<ReturnType<typeof setInterval>> = new Set();
  const sensitiveWordTimeoutMs = options.sensitiveWordTimeoutMs ?? 6_000;

  // 命名 wrapper：Playwright EventEmitter 按引用匹配，uninstall 才能 off 同一个引用。
  const requestHandler = (request: any) => handleRequest(state, request);
  const responseHandler = (response: any) => onResponseSync(state, sensitiveWordTimeoutMs, response);

  if (typeof page?.on === "function") {
    page.on("request", requestHandler);
    page.on("response", responseHandler);
  }

  const uninstall = createUninstall(page, state, timers, requestHandler, responseHandler);
  const waitForSave = createWaitForSave(state, timers, options);

  return { waitForSave, uninstall };
}