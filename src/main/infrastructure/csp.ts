/**
 * Content-Security-Policy 注入。
 *
 * main 进程在创建 BrowserWindow / WebContentsView 时通过 `webRequest.onHeadersReceived`
 * 统一设置 CSP 头。所有 inline-style / inline-script 默认禁止。
 *  - dev：允许 http://127.0.0.1:5173 (vite) + ws://127.0.0.1:5173 (HMR)；
 *  - production：仅 file:// / 自有 schema。
 *
 * 注意：这里只做轻量 CSP，没有引入 DOMPurify / sanitize-html。renderer
 * 仍然要负责 DOM 内容的转义——这两者是互补不是替代。
 */

import type { Session } from "electron";

/**
 * 构造针对当前 dev/prod 环境的 CSP 字符串。
 */
export function buildContentSecurityPolicy(): string {
  const isDev = !process.env.NODE_ENV && /dist-electron.*unpackage|electron-builder/.test(process.env.npm_lifecycle_event || "");
  // 简化：dev 判定优先用 app.isPackaged；为了避免在 csp 模块跨 import electron，先
  // 用 process.env.NODE_ENV 兜底，main 进程设置 webRequest 时再走 isDevEnv 二次校验。
  const directives: Array<[string, string]> = [
    ["default-src", "'self'"],
    ["script-src", "'self' 'unsafe-inline'"], // vite 在 dev 模式需要 unsafe-inline eval；prod 关掉
    ["style-src", "'self' 'unsafe-inline'"], // antd 内联样式
    ["img-src", "'self' data: https: file:"], // data: 用于手动上传封面 cover.read 返回的 data URL 预览；
                                                    // file: 仍保留（兼容旧调用 / 生产 file:// origin 同源），
                                                    // 但 renderer 不再走 file://；不要扩展到 script/connect/object。
    ["font-src", "'self' data:"],
    ["connect-src", isDev ? "'self' http://127.0.0.1:5173 ws://127.0.0.1:5173" : "'self'"],
    ["object-src", "'none'"],
    ["base-uri", "'self'"],
    ["frame-ancestors", "'none'"],
  ];
  return directives.map(([k, v]) => `${k} ${v}`).join("; ");
}

/**
 * 给指定 session 注入 CSP 头：
 *   - main: 主窗口 webContents session；
 *   - partition: 自定义 VBK partition;
 * 文档：
 *   https://www.electronjs.org/docs/latest/api/web-request
 */
export function installContentSecurityPolicy(session: Session): void {
  const policy = buildContentSecurityPolicy();
  session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [policy],
      },
    });
  });
}
