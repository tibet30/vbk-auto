/**
 * 渲染进程侧的品牌资源入口：集中导出应用名与本地 Logo URL。
 * Logo 由 Vite 静态资源 import 处理（见 `assets.d.ts` 中 `*.png` 声明）。
 */
import { APP_NAME as SHARED_APP_NAME } from "../../shared/brand";
import logoUrl from "../assets/brand/logo.png";

export const APP_NAME = SHARED_APP_NAME;
export const LOGO_URL: string = logoUrl;
export const LOGO_ALT = `${APP_NAME} Logo`;
