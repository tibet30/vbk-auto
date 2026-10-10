/**
 * Save monitor 的 request / response 事件 handler：
 *   - handleRequest：一旦看到 /15638/checkSensitiveWord 飞出，pendingSensitive++；
 *   - handleResponse：save / sensitive 两个 path 各自命中对应分支；
 *   - onResponseSync：uninstall 之前 page.off 与 page.on 必须用同一个引用，
 *     Playwright EventEmitter 按引用匹配，所以这里把 wrapper 提为命名函数。
 *
 * 与 settlement.ts 互不耦合；handler 只调用 settlement.ts 中的纯函数，
 * 不直接读 monitor 状态对象的内部字段。
 */

import { logWarn } from "../../../../../shared/log-timestamp.js";
import {
  CHECK_SENSITIVE_WORD_PATH,
  SAVE_DESCRIPTION_INFO_PATH,
  pathMatches,
} from "./constants.js";
import {
  applySaveOutcome,
  onSaveResponse,
  onSensitiveResponse,
  type MonitorState,
} from "./settlement.js";

/**
 * 响应处理：playwright Page 的 'response' 回调可能为 async，handler 内
 * 必须用 void + .catch 包裹，避免未处理 Promise rejection。
 */
export const handleResponse = async (
  state: MonitorState,
  sensitiveWordTimeoutMs: number,
  response: any,
) => {
  if (state.disposed) return;
  if (!response || typeof response.url !== "function") return;
  const url: string = (() => {
    try { return response.url(); } catch { return ""; }
  })();
  if (!url) return;
  try {
    if (pathMatches(url, SAVE_DESCRIPTION_INFO_PATH)) {
      const body = await response.json().catch(() => null);
      if (state.disposed) return;
      onSaveResponse(state, response.status?.() ?? 0, body, sensitiveWordTimeoutMs);
      return;
    }
    if (pathMatches(url, CHECK_SENSITIVE_WORD_PATH)) {
      const body = await response.json().catch(() => null);
      if (state.disposed) return;
      onSensitiveResponse(state, response.status?.() ?? 0, body);
    }
  } catch (error) {
    // 网络 / 解析错误时不静默：等 waitForSave 超时再抛；已 settled 时直接吞。
    if (state.settled || state.disposed) return;
    // 不在这里 settle —— 协议上我们等超时再判定「未在窗口内收到业务响应」；
    // 解析失败只是一次响应坏掉，不应直接 reject（可能还有下一次同路径响应）。
  }
};

/**
 * 请求阶段处理：一旦看到 /15638/checkSensitiveWord 飞出，pendingSensitive++，
 * 让 onSaveResponse 知道「现在先不要结算」；save 自身不需要 pending —— 业务上
 * 一个产品图文保存只对应一次 save 响应，且响应先到 / 后到是同效的。
 */
export const handleRequest = (state: MonitorState, request: any) => {
  if (state.disposed) return;
  if (!request || typeof request.url !== "function") return;
  const url: string = (() => {
    try { return request.url(); } catch { return ""; }
  })();
  if (!url) return;
  if (pathMatches(url, CHECK_SENSITIVE_WORD_PATH)) {
    state.pendingSensitive += 1;
    state.sensitiveRequestsSeen += 1;
  }
};

/**
 * 异步 wrapper：uninstall 时 off 必须 off 同一个引用。Page.on('response') 在
 * Playwright 里是 EventEmitter 语义，匿名函数无法 off 掉 —— 所以这里把 wrapper
 * 提为命名函数 + 用 handleResponse 的引用做 key。
 */
export const onResponseSync = (
  state: MonitorState,
  sensitiveWordTimeoutMs: number,
  response: any,
) => {
  if (state.disposed) return;
  void handleResponse(state, sensitiveWordTimeoutMs, response).catch((error) => {
    if (state.settled || state.disposed) return;
    logWarn("[save-monitor] response handler error", {
      message: (error as Error)?.message ?? String(error),
    });
  });
};