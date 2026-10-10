/**
 * Save monitor 的 settlement（结算）原语：
 *   - readBodyFields：把官方响应 body 归一化为 success / ack / sensitiveWords；
 *   - settle：缓存 outcome/error 并通过 queueMicrotask 推到下一个微任务；
 *   - applySaveOutcome：按业务字段判定 success=true && Ack=Success；
 *   - onSaveResponse / onSensitiveResponse：处理 save 与敏感词响应的优先级冲突。
 *
 * 这些纯函数以参数形式接收 monitor 状态对象（见 MonitorState 接口），让 install
 * 函数的闭包状态能被单独测试 + 复用。
 *
 * 优先级规则：
 *   - 敏感词命中永远优先失败 —— 即便 save 已收 success=true 也覆盖；
 *   - success=false 或 Ack 非 Success → 立即结算为业务失败（不允许 retry）。
 */

import { PresentationSensitiveWordsError } from "./types.js";
import type { SaveMonitorOutcome } from "./types.js";

export interface MonitorState {
  /** 是否已结算（无论 success / 失败）；再触发的 settle 直接丢弃。 */
  settled: boolean;
  /** monitor 已 uninstall：所有后续事件都直接丢弃。 */
  disposed: boolean;
  /** 当前还在等待响应的 /15638/checkSensitiveWord 请求数。 */
  pendingSensitive: number;
  /** 排队中的 save response：pendingSensitive>0 时若 save 已到，先缓存到这。 */
  pendingSaveResponse: { httpStatus: number; body: any } | null;
  /** save / sensitive response 缓存（用于超时错误信息）。 */
  savedResponse: { body: any; httpStatus: number } | null;
  sensitiveResponse: { body: any; httpStatus: number } | null;
  /** 已观察到的「checkSensitiveWord 请求」数量（包括未回响的）。 */
  sensitiveRequestsSeen: number;
  /** 已观察到的「checkSensitiveWord 响应」数量（含无敏感词命中）。 */
  sensitiveResponsesSeen: number;
  /** waitForSave() 启动的时间戳；用于判定异常 ordering 兜底窗口。 */
  waitStartTs: number | null;
  /** 缓存的等待结果 / 错误。 */
  cachedError: Error | null;
  cachedOutcome: SaveMonitorOutcome | null;
  resolveWait: ((outcome: SaveMonitorOutcome) => void) | null;
  rejectWait: ((error: Error) => void) | null;
}

/**
 * 把官方响应 business body 归一化；只读 success / ResponseStatus.Ack / sensitiveWords，
 * 不读 cookie / Authorization / X-* 等凭据字段。
 */
export function readBodyFields(body: any) {
  if (!body || typeof body !== "object") {
    return { success: null, ack: "", sensitiveWords: [] as string[] };
  }
  const responseStatus = (body as any).ResponseStatus ?? (body as any).responseStatus;
  const ack = typeof responseStatus === "object" && responseStatus !== null
    ? String((responseStatus as any).Ack ?? "")
    : "";
  const success = (body as any).success;
  const rawSensitive = (body as any).sensitiveWords ?? (body as any).SensitiveWords ?? [];
  const sensitiveWords = Array.isArray(rawSensitive)
    ? rawSensitive.map((value: unknown) => String(value ?? "").trim()).filter(Boolean)
    : [];
  return {
    success: typeof success === "boolean" ? success : null,
    ack,
    sensitiveWords,
  };
}

/**
 * 内部结算：缓存 outcome/error，并把 resolve/reject 推到下一个 microtask；
 * 这样如果 response handler 在 waitForSave() 还没被调用时就触发，
 * 不会因为 reject 找不到 awaiter 而打 unhandledRejection 警告。
 *
 * 已被 disposed 或已 settled 时直接返回；调用方无需自己双重判定。
 */
export function settle(state: MonitorState, outcome: SaveMonitorOutcome | null, error: Error | null) {
  if (state.settled || state.disposed) return;
  state.settled = true;
  if (error) state.cachedError = error;
  else state.cachedOutcome = outcome as SaveMonitorOutcome;
  queueMicrotask(() => {
    if (state.cachedError) {
      if (state.rejectWait) state.rejectWait(state.cachedError);
    } else if (state.cachedOutcome && state.resolveWait) {
      state.resolveWait(state.cachedOutcome);
    }
  });
}

/**
 * 官方保存响应命中：success=true 且 Ack=Success → 立即结算为成功；
 * success=false 或 Ack 非 Success → 立即结算为业务失败（不允许 retry，不允许兜底）。
 *
 * 当 pendingSensitive>0 时（敏感词检测请求还在飞），把本次响应缓存到
 * pendingSaveResponse，等所有敏感词响应收尾再回放 —— 防止「保存先到、敏感词
 * 后到」被错判为成功。
 *
 * 异常 ordering 兜底：若 waitStartTs 已经超过 sensitiveWordTimeoutMs（说明
 * 已经给敏感词一个完整等待窗口却仍 pendingSensitive>0），不再继续缓存，强制结算
 * save —— 否则「敏感词请求飞出但 response 永不回响」会让 waitForSave 永远 pending。
 */
export function onSaveResponse(
  state: MonitorState,
  httpStatus: number,
  body: any,
  sensitiveWordTimeoutMs: number,
) {
  if (state.disposed) return;
  state.savedResponse = { body, httpStatus };
  if (state.pendingSensitive > 0) {
    const waitElapsed = state.waitStartTs == null ? 0 : Date.now() - state.waitStartTs;
    if (waitElapsed < sensitiveWordTimeoutMs) {
      state.pendingSaveResponse = { httpStatus, body };
      return;
    }
    state.pendingSensitive = 0;
    state.pendingSaveResponse = null;
  }
  applySaveOutcome(state, httpStatus, body);
}

/**
 * 真正按业务字段结算 save 响应。被 onSaveResponse + pending 回放两个入口共用。
 */
export function applySaveOutcome(state: MonitorState, httpStatus: number, body: any) {
  if (state.settled || state.disposed) return;
  const fields = readBodyFields(body);
  const ackOk = fields.ack === "Success" || fields.ack === "SUCCESS";
  if (fields.success === true && ackOk) {
    settle(state, {
      saved: true,
      httpStatus,
      ack: fields.ack,
      success: true,
      sensitiveWords: fields.sensitiveWords,
    }, null);
    return;
  }
  const detail = `success=${String(fields.success)} Ack=${fields.ack || "<empty>"}`;
  settle(state, null, new Error(`产品图文保存业务未成功：${detail}；HTTP=${httpStatus}`));
}

/**
 * 敏感词响应：命中立即失败；否则递减 pending，必要时回放缓存中的 save。
 */
export function onSensitiveResponse(state: MonitorState, httpStatus: number, body: any) {
  if (state.disposed) return;
  state.sensitiveResponse = { body, httpStatus };
  const fields = readBodyFields(body);
  if (fields.sensitiveWords.length > 0) {
    settle(state, null, new PresentationSensitiveWordsError(fields.sensitiveWords, httpStatus));
    return;
  }
  if (state.pendingSensitive > 0) state.pendingSensitive -= 1;
  state.sensitiveResponsesSeen += 1;
  if (state.pendingSaveResponse && state.pendingSensitive === 0) {
    const cached = state.pendingSaveResponse;
    state.pendingSaveResponse = null;
    applySaveOutcome(state, cached.httpStatus, cached.body);
  }
}