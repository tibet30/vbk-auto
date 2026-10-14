/**
 * 启动期数据目录与单实例守卫
 * ==========================
 *
 * 这两件事必须在 `app.whenReady()` 之前完成，且必须放在一起看：
 *
 * 1. userData 解析：安装实例（/Applications/三人同游.app）与开发实例（`electron .`）
 *    默认都会解析到同一个 `app.getPath("userData")`。两者共用同一把单实例锁、
 *    同一个业务库和同一份 Chromium profile，后果是后启动的实例在主窗口建出后
 *    立刻退出（表现为「App 一闪即关」），并可能互相写坏数据。
 *    因此开发态默认落到 `<userData>-dev`，需要沿用正式数据时显式给
 *    `VBK_USER_DATA_DIR=<正式 userData>`。
 *
 * 2. 单实例守卫：拿不到锁的实例必须立刻 `exit(0)`，绝不能继续进入启动引导 ——
 *    `app.whenReady()` 回调会建出主窗口，窗口随后随进程退出而消失，就是历史上
 *    看到的「闪一下然后关闭」。
 *
 * 本文件刻意不 import electron：依赖以结构化接口传入，便于直接单测。
 */

/** 开发态 userData 目录后缀。 */
export const DEVELOPMENT_USER_DATA_SUFFIX = "-dev";

/** `VBK_USER_DATA_DIR`：显式指定 userData 的环境变量。 */
export const USER_DATA_DIR_ENV = "VBK_USER_DATA_DIR";

export interface StartupUserDataDir {
  directory: string;
  /** true 表示未显式覆盖、由开发态自动隔离出的目录。 */
  isolated: boolean;
}

export interface UserDataPathApp {
  getPath(name: "userData"): string;
  setPath(name: "userData", path: string): void;
}

export interface SingleInstanceApp {
  requestSingleInstanceLock(): boolean;
  on(event: "second-instance", listener: () => void): unknown;
  exit(code: number): void;
}

/** 安装实例与开发实例必须使用不同的 userData 目录。 */
export function resolveStartupUserDataDir(
  environment: NodeJS.ProcessEnv,
  packaged: boolean,
  defaultDirectory: string,
): StartupUserDataDir {
  const override = environment[USER_DATA_DIR_ENV]?.trim();
  if (override) return { directory: override, isolated: false };
  if (packaged) return { directory: defaultDirectory, isolated: false };
  return { directory: `${defaultDirectory}${DEVELOPMENT_USER_DATA_SUFFIX}`, isolated: true };
}

/** 解析并落地 userData；仅在确实需要改写时调用 `setPath`。 */
export function applyStartupUserDataDir(
  application: UserDataPathApp,
  environment: NodeJS.ProcessEnv,
  packaged: boolean,
): StartupUserDataDir {
  const resolved = resolveStartupUserDataDir(environment, packaged, application.getPath("userData"));
  if (resolved.directory !== application.getPath("userData")) application.setPath("userData", resolved.directory);
  return resolved;
}

/**
 * 取得单实例锁并在成功时注册 `second-instance`（把已有窗口带到前台）。
 * 拿不到锁时立刻退出进程：`app.exit()` 不触发 before-quit / will-quit，
 * 因此不会再有机会建出主窗口。
 */
export function acquireSingleInstanceLock(
  application: SingleInstanceApp,
  onSecondInstance: () => void,
): boolean {
  if (application.requestSingleInstanceLock()) {
    application.on("second-instance", onSecondInstance);
    return true;
  }
  application.exit(0);
  return false;
}
