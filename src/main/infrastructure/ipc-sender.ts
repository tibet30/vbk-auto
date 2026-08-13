/**
 * IPC sender validation utilities.
 *
 * 主要职责：
 *  - 校验进入主进程 IPC handler 的 webContents 来源。仅允许：
 *     - 主 BrowserWindow 的 main frame；
 *     - dev：固定 Vite loopback origin；packaged：本地 file: renderer。
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

import { app, BrowserWindow, ipcMain as electronIpcMain, type IpcMainInvokeEvent } from "electron";
import { validateIpcArguments } from "./ipc-input.js";
import { isTrustedRendererSender } from "./ipc-sender-policy.js";

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
 *    入口覆盖 wrapper。即便是只读入口（products:list 等），未来追加
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
 * 所有业务 registrar 使用的安全 IPC 门面。
 *
 * 保持与 Electron `ipcMain.handle(channel, handler)` 相同的注册形态，但统一在
 * handler 之前验证 sender，避免新增通道时忘记手写 assertTrustedSender。
 */
type ElectronInvokeHandler = Parameters<typeof electronIpcMain.handle>[1];

export const secureIpcMain = {
  handle(channel: string, handler: ElectronInvokeHandler): void {
    electronIpcMain.handle(channel, async (event, ...args) => {
      assertTrustedSender(event, channel);
      validateIpcArguments(channel, args);
      return handler(event, ...args);
    });
  },
};

/**
 * 解析 sender 来路：
 *   - url：实际发起 invoke 的 frame URL；
 *   - isOwner：当前 webContents 是否属于主 BrowserWindow。
 *   - isMainFrame：拒绝主窗口里嵌入的外部 frame 借用 preload API。
 */
export function describeSender(event: IpcMainInvokeEvent): {
  url: string;
  isOwner: boolean;
  isMainFrame: boolean;
  isDev: boolean;
} {
  const isDev = isDevEnv();
  const sender = event.sender;
  const owner = BrowserWindow.fromWebContents(sender);
  const isOwner = Boolean(owner);
  const senderFrame = event.senderFrame;
  const isMainFrame = Boolean(senderFrame && senderFrame === sender.mainFrame);
  const url = senderFrame?.url || sender.getURL?.() || "";
  return { url, isOwner, isMainFrame, isDev };
}

/**
 * 拦截非法 sender。具体规则：
 *  - 必须来自主 BrowserWindow 的 main frame；
 *  - dev 仅允许 create-window.ts 实际加载的 http://127.0.0.1:5173；
 *  - packaged 仅允许 file:（注意 file URL 的 URL.origin 实际是 "null"）；
 *  - 任何其它协议、端口、外部 frame 或非法 URL 都拒绝。
 *
 * 失败抛 Error("sender not trusted") 以便主进程 IPC 路由拒绝。
 */
export function assertTrustedSender(event: IpcMainInvokeEvent, channel: string): void {
  const sender = describeSender(event);
  if (isTrustedRendererSender(sender)) return;
  throw new Error(
    `[ipc] sender not trusted: channel=${channel} owner=${sender.isOwner} mainFrame=${sender.isMainFrame} url=${sender.url || "<empty>"}`,
  );
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
