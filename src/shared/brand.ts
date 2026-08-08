/**
 * 应用品牌常量：主进程与渲染进程共享的字符串常量。
 *
 * 图片资源（Logo）由 Vite 打包并以 URL 形式注入，因此单独放在
 * `src/renderer/app/brand.ts`，主进程不应引用，避免 tsc 编译时遇到
 * 二进制资源 import。
 */
export const APP_NAME = "三人同游";
