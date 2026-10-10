/**
 * waitForSave + uninstall 双时序：
 *   - waitForSave：先用 sensitiveWordTimeoutMs 窗口等待敏感词结果，再用
 *     saveTimeoutMs 等待官方 save 响应；命中立即结算，否则按超时 reject；
 *   - uninstall：清掉 page.on / page.off 同引用的 listener、清掉所有 timer、
 *     把 disposed 置 true，并主动 cancel 仍等待中的 waitForSave()。
 *
 * 与 settlement.ts / handlers.ts 配合：settlement 给状态读写入口，handlers 给
 * event 触发入口，timeout 给"时间到了就该做什么"的兜底。
 */

import {
  CHECK_SENSITIVE_WORD_PATH,
  DEFAULT_SAVE_TIMEOUT_MS,
  DEFAULT_SENSITIVE_WORD_TIMEOUT_MS,
  SAVE_DESCRIPTION_INFO_PATH,
} from "./constants.js";
import { applySaveOutcome, type MonitorState } from "./settlement.js";
import { handleRequest, onResponseSync } from "./handlers.js";
import type { SaveMonitorOutcome } from "./types.js";

/**
 * 卸载监听器、清掉所有 timer、置 disposed=true 防 leak；
 * 仍等待中的 waitForSave() 会被显式 reject 取消，避免「调用方 fire-and-forget
 * uninstall 后 waitForSave 永远 pending」的资源泄漏。
 *
 * 顺序很关键：
 *   1) 先把 listener / timer 都摘掉，避免后续 settle 之后还有事件进来；
 *   2) 仍等待中 → 缓存 cancel error 到 cachedError；
 *   3) 再把 disposed 置 true —— 因为 settle 内部会读 disposed，且我们必须保证
 *      这次主动 settle 调用一定要把 cancel error 落到 rejectWait 上（不能
 *      因为「提前 disposed=true」导致 settle 直接 return，waitForSave 永远悬挂）。
 *      所以**先 settle 后置 disposed**，否则 fire-and-forget uninstall 后
 *      waitForSave 永远 pending。
 */
export function createUninstall(
  page: any,
  state: MonitorState,
  timers: Set<ReturnType<typeof setInterval>>,
  handleRequestRef: (request: any) => void,
  onResponseSyncRef: (response: any) => void,
): () => void {
  return function uninstall() {
    try {
      if (typeof page?.off === "function") {
        page.off("response", onResponseSyncRef as (response: any) => void);
        page.off("request", handleRequestRef as (request: any) => void);
      }
    } catch {
      // ignore
    }
    for (const timer of timers) {
      try { clearInterval(timer); } catch { /* ignore */ }
    }
    timers.clear();
    if (!state.settled) {
      const err = new Error("save monitor 已被卸载（disposed），等待已取消");
      if (state.rejectWait) {
        state.settled = true;
        state.cachedError = err;
        queueMicrotask(() => {
          if (state.rejectWait) state.rejectWait(err);
        });
      } else {
        state.settled = true;
        state.cachedError = err;
      }
    }
    state.disposed = true;
  };
}

/**
 * 等待官方 /15638/savedescriptioninfo 响应：
 *   - 必须 success=true 且 Ack=Success 才返回 saved=true；
 *   - 业务失败 / Ack 异常 / 无响应（超时）都抛错；
 *   - 敏感词命中同样抛错（独立于 save 响应，已在 onSensitiveResponse 内 settle）。
 *
 * 返回 SaveMonitorOutcome；失败直接抛 Error，不返回 saved=false 的「温和」结果，
 * 调用方不要 try-catch 后默认走兜底。
 *
 * 同一 monitor 实例只允许调一次 waitForSave()；重复调用复用同一 promise。
 */
export function createWaitForSave(
  state: MonitorState,
  timers: Set<ReturnType<typeof setInterval>>,
  options: { saveTimeoutMs?: number; sensitiveWordTimeoutMs?: number },
): () => Promise<SaveMonitorOutcome> {
  const saveTimeoutMs = options.saveTimeoutMs ?? DEFAULT_SAVE_TIMEOUT_MS;
  const sensitiveWordTimeoutMs = options.sensitiveWordTimeoutMs ?? DEFAULT_SENSITIVE_WORD_TIMEOUT_MS;

  let waitPromise: Promise<SaveMonitorOutcome> | null = null;

  return function waitForSave(): Promise<SaveMonitorOutcome> {
    if (waitPromise) return waitPromise;
    if (state.disposed) {
      return Promise.reject(new Error("save monitor 已被卸载（disposed），无法等待保存响应"));
    }
    waitPromise = new Promise<SaveMonitorOutcome>((resolve, reject) => {
      if (state.cachedError) {
        queueMicrotask(() => reject(state.cachedError));
        return;
      }
      if (state.cachedOutcome) {
        queueMicrotask(() => resolve(state.cachedOutcome as SaveMonitorOutcome));
        return;
      }
      state.resolveWait = resolve;
      state.rejectWait = reject;
      state.waitStartTs = Date.now();

      const sensDeadline = Date.now() + sensitiveWordTimeoutMs;
      const sensTimer = setInterval(() => {
        if (state.settled || state.disposed) {
          clearInterval(sensTimer);
          timers.delete(sensTimer);
          return;
        }
        if (Date.now() >= sensDeadline) {
          clearInterval(sensTimer);
          timers.delete(sensTimer);
          const saveDeadline = Date.now() + saveTimeoutMs;
          const saveTimer = setInterval(() => {
            if (state.settled || state.disposed) {
              clearInterval(saveTimer);
              timers.delete(saveTimer);
              return;
            }
            if (Date.now() >= saveDeadline) {
              clearInterval(saveTimer);
              timers.delete(saveTimer);
              if (state.pendingSaveResponse) {
                const cached = state.pendingSaveResponse;
                state.pendingSaveResponse = null;
                state.pendingSensitive = 0;
                applySaveOutcome(state, cached.httpStatus, cached.body);
                return;
              }
              state.settled = true;
              const err: Error = new Error(
                `产品图文保存未在 ${saveTimeoutMs}ms 内收到官方 ${SAVE_DESCRIPTION_INFO_PATH} 响应；` +
                `savedResponse=${state.savedResponse ? `已捕获 HTTP=${state.savedResponse.httpStatus}` : "<未捕获>"}，` +
                `sensitiveResponse=${state.sensitiveResponse ? `已捕获 HTTP=${state.sensitiveResponse.httpStatus}` : "<未捕获>"}` +
                `，pendingSensitive=${state.pendingSensitive}，` +
                `sensitiveRequestsSeen=${state.sensitiveRequestsSeen}，` +
                `sensitiveResponsesSeen=${state.sensitiveResponsesSeen}`,
              );
              state.cachedError = err;
              queueMicrotask(() => {
                if (state.rejectWait) state.rejectWait(err);
              });
            }
          }, 80);
          timers.add(saveTimer);
        }
      }, 80);
      timers.add(sensTimer);
    });
    return waitPromise;
  };
}

/** 用来避免被 tree-shake 掉的 unused 引用；CHECK_SENSITIVE_WORD_PATH
 *  只是为了在 IDE 跳转里能定位到常量声明位置。 */
void CHECK_SENSITIVE_WORD_PATH;
void handleRequest;