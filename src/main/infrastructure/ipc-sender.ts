/**
 * IPC sender validation utilities.
 *
 * 主要职责：
 *  - 校验进入主进程 IPC handler 的 webContents 来源。仅允许：
 *     - 主 BrowserWindow 的 webContents（主窗口）
 *     - 当 isDev=true 时，附加允许 devtools / 浏览器打开 dev server 进来的
 *       webContents（url 形式 http://127.0.0.1:5173 or file://）
 *  - 拒绝任何 origin / frame 来自外部域名的调用。
 *  - 抛错而不是返回 false，让调用方代码 (ipcMain.handle) 不至于"忘记检查"。
 *
 * 调用约定：
 *   ipcMain.handle("...", async (event, ...args) => {
 *     assertTrustedSender(event, "...");
 *     ...
 *   });
 *
 * 调试（automation:debug:*）类 IPC 走 assertDebugEnabled()：仅 dev + VBK_DEBUG=1。
 */

import { app, BrowserWindow, type IpcMainInvokeEvent } from "electron";

let cachedDevFlag: boolean | undefined;
/**
 * 集中读取 isDev：避免在不同 IPC handler 里 import 顺序 / cache 不一致。
 * 一旦 app.isPackaged 为 false 即为 dev。
 */
export function isDevEnv(): boolean {
  if (cachedDevFlag === undefined) {
    // 主进程是 ESM（package.json "type": "module"），顶层静态 import 即可；
    // 之前用 require("electron") 会触发 ReferenceError: require is not defined。
    cachedDevFlag = !app.isPackaged;
  }
  return cachedDevFlag;
}

/**
 * 高风险 IPC 入口的便捷包装：先 assertTrustedSender 再调原 handler。
 *  - 不想全量改动 50+ ipcMain.handle 时，只在"会改 / 删 / 触发远端动作"
 *    入口覆盖 wrapper。即便是只读入口（projects:list 等），未来追加
 *    sender 校验时也能直接换 `ipcMain.handle(...)` 为 `secureIpc(...)`。
 */
export function secureIpc<TArgs extends unknown[], TReturn>(
  channel: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (event: IpcMainInvokeEvent, ...args: TArgs) => TReturn | Promise<TReturn>,
): (event: IpcMainInvokeEvent, ...args: TArgs) => Promise<TReturn> {
  return (async (event: IpcMainInvokeEvent, ...args: TArgs) => {
    assertTrustedSender(event, channel);
    return handler(event, ...args);
  }) as (event: IpcMainInvokeEvent, ...args: TArgs) => Promise<TReturn>;
}

/**
 * 解析 sender 来路。返回 [origin, isOwner]：
 *   - origin：URL.origin（非协议 → 空字符串）
 *   - isOwner：当前 webContents 是否属于主 BrowserWindow。
 *  - 抛错：sender 不可信或来自不可识别的 BrowserWindow。
 */
export function describeSender(event: IpcMainInvokeEvent): { origin: string; isOwner: boolean; isDev: boolean } {
  const isDev = isDevEnv();
  const sender = event.sender;
  const owner = BrowserWindow.fromWebContents(sender);
  const isOwner = Boolean(owner);
  const url = sender.getURL?.() || "";
  let origin = "";
  try {
    origin = new URL(url).origin;
  } catch {
    origin = "";
  }
  return { origin, isOwner, isDev };
}

/**
 * 拦截非法 sender。具体规则：
 *  - 必须来自主 BrowserWindow（isOwner=true）；
 *  - dev 模式下允许 origin=http://127.0.0.1:5173；
 *  - 生产模式下允许 origin=file://（本地加载渲染产物）；
 *  - 任何其它 origin / 无 owner 视为不可信。
 *
 * 失败抛 Error("sender not trusted") 以便主进程 IPC 路由拒绝。
 */
export function assertTrustedSender(event: IpcMainInvokeEvent, channel: string): void {
  const { origin, isOwner, isDev } = describeSender(event);
  if (!isOwner) {
    throw new Error(`[ipc] sender not trusted: channel=${channel} owner=false`);
  }
  if (isDev) {
    // dev: 允许 127.0.0.1 (vite) / localhost / 空 origin (about:blank)
    if (origin && origin !== "http://127.0.0.1:5173" && origin !== "http://localhost:5173") {
      throw new Error(`[ipc] sender not trusted: channel=${channel} origin=${origin}`);
    }
    return;
  }
  // production: 允许 file:// origin
  if (origin && origin !== "file://") {
    throw new Error(`[ipc] sender not trusted: channel=${channel} origin=${origin}`);
  }
}

/**
 * 调试 IPC 通道的总闸。两条必须同时为真：
 *  - dev：app.isPackaged===false；
 *  - VBK_DEBUG=1：用户/测试显式开启。
 * 任意一条不满足 → 抛错。
 */
export function assertDebugEnabled(channel: string): void {
  const debugEnabled = process.env.VBK_DEBUG === "1";
  if (!isDevEnv() || !debugEnabled) {
    throw new Error(`[ipc] debug channel disabled: ${channel}`);
  }
}
