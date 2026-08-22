import type { LogLevel } from "../shared/contracts.js";
import { createRuntimeLogCapture } from "../shared/log-redaction.js";

let installed = false;

/**
 * 捕获 renderer 的原生 console 输出（含 React / 第三方库），发送到主进程落库。
 * 保留原 console 行为；IPC 失败静默降级，避免日志系统制造递归日志。
 */
export function installRendererLogCapture(): void {
  if (installed || !window.vbk?.operationLog?.capture) return;
  installed = true;
  const methods: Array<[keyof Console, LogLevel]> = [
    ["debug", "debug"],
    ["info", "info"],
    ["log", "info"],
    ["warn", "warn"],
    ["error", "error"],
  ];
  for (const [method, level] of methods) {
    const original = console[method].bind(console) as (...args: unknown[]) => void;
    Object.defineProperty(console, method, {
      configurable: true,
      value: (...args: unknown[]) => {
        original(...args);
        try {
          const input = createRuntimeLogCapture(level, "renderer", args);
          void window.vbk!.operationLog.capture(input).catch(() => undefined);
        } catch {
          // 某些第三方对象带抛错 getter；console 本身仍已正常输出。
        }
      },
    });
  }
}
