/**
 * vbk-session-request 超时工具：
 *   - VbkSessionRequestTimeoutError：超时专用错误类型；
 *   - timeoutOrDefault：负数 / NaN / undefined → fallback；
 *   - rejectAfter：把任意 Promise 包成"超时报 reject"版。
 */

export class VbkSessionRequestTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VbkSessionRequestTimeoutError";
  }
}

export function timeoutOrDefault(value: number | undefined, fallback: number) {
  return Number.isFinite(value) && value! > 0 ? Math.floor(value!) : fallback;
}

export function rejectAfter<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => reject(new VbkSessionRequestTimeoutError(message)), timeoutMs);
    promise.then(resolve, reject).finally(() => { if (timer) clearTimeout(timer); });
  });
}