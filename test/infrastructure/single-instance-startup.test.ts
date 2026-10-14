/**
 * 启动期数据目录与单实例守卫契约
 * ==============================
 *
 *   - 安装实例与 dev 实例必须落在不同 userData：共用目录会争抢同一把单实例锁，
 *     并共写同一个业务库；
 *   - 拿不到锁的实例必须在 `app.whenReady()` 之前退出，不能再建主窗口
 *     （历史症状：App 窗口一闪即关）。
 *
 * 断言分两层：纯逻辑直接调函数，接线顺序读 main.ts 源码做白盒断言
 * （与仓库既有的启动期契约测试同风格，不依赖 jsdom / electron 运行时）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  DEVELOPMENT_USER_DATA_SUFFIX,
  USER_DATA_DIR_ENV,
  acquireSingleInstanceLock,
  applyStartupUserDataDir,
  resolveStartupUserDataDir,
} from "../../src/main/startup-data-dir.js";

const mainSource = readFileSync(new URL("../../src/main/main.ts", import.meta.url), "utf8");
const DEFAULT_DIR = "/Users/test/Library/Application Support/三人同游";

test("开发态默认隔离 userData，显式覆盖与打包态保持原目录", () => {
  assert.deepEqual(resolveStartupUserDataDir({}, false, DEFAULT_DIR), {
    directory: `${DEFAULT_DIR}${DEVELOPMENT_USER_DATA_SUFFIX}`,
    isolated: true,
  });
  assert.deepEqual(resolveStartupUserDataDir({ [USER_DATA_DIR_ENV]: "  /tmp/vbk-dev  " }, false, DEFAULT_DIR), {
    directory: "/tmp/vbk-dev",
    isolated: false,
  });
  assert.deepEqual(resolveStartupUserDataDir({ [USER_DATA_DIR_ENV]: "   " }, false, DEFAULT_DIR), {
    directory: `${DEFAULT_DIR}${DEVELOPMENT_USER_DATA_SUFFIX}`,
    isolated: true,
  });
  assert.deepEqual(resolveStartupUserDataDir({}, true, DEFAULT_DIR), {
    directory: DEFAULT_DIR,
    isolated: false,
  });
});

test("applyStartupUserDataDir 只在需要改写时才调用 setPath", () => {
  const applied: string[] = [];
  const fakeApp = {
    getPath: () => DEFAULT_DIR,
    setPath: (_name: "userData", directory: string) => { applied.push(directory); },
  };
  assert.equal(applyStartupUserDataDir(fakeApp, {}, true).isolated, false);
  assert.deepEqual(applied, [], "打包态不得改写 userData");
  assert.equal(applyStartupUserDataDir(fakeApp, {}, false).directory, `${DEFAULT_DIR}${DEVELOPMENT_USER_DATA_SUFFIX}`);
  assert.deepEqual(applied, [`${DEFAULT_DIR}${DEVELOPMENT_USER_DATA_SUFFIX}`]);
});

test("拿不到单实例锁的实例立刻 exit(0)，且不注册 second-instance", () => {
  const registered: string[] = [];
  const exits: number[] = [];
  const locked = {
    requestSingleInstanceLock: () => true,
    on: (event: "second-instance") => { registered.push(event); },
    exit: (code: number) => { exits.push(code); },
  };
  assert.equal(acquireSingleInstanceLock(locked, () => {}), true);
  assert.deepEqual(registered, ["second-instance"]);
  assert.deepEqual(exits, [], "拿到锁的实例不得退出");

  const rejected = {
    requestSingleInstanceLock: () => false,
    on: () => { throw new Error("拿不到锁时不得注册 second-instance"); },
    exit: (code: number) => { exits.push(code); },
  };
  assert.equal(acquireSingleInstanceLock(rejected, () => {}), false);
  assert.deepEqual(exits, [0], "拿不到锁必须 exit(0)（不触发 before-quit）");
});

test("userData 与单实例守卫都早于 app.whenReady()，且引导会跳过拿不到锁的实例", () => {
  const userDataAt = mainSource.indexOf("applyStartupUserDataDir(app,");
  const lockAt = mainSource.indexOf("acquireSingleInstanceLock(app,");
  const readyAt = mainSource.indexOf("app.whenReady().then(");
  assert.ok(userDataAt >= 0, "main.ts 必须解析启动期 userData");
  assert.ok(lockAt >= 0, "main.ts 必须取得单实例锁");
  assert.ok(readyAt >= 0, "main.ts 必须保留 whenReady 引导");
  assert.ok(userDataAt < readyAt, "userData 必须在注册 whenReady 引导之前确定");
  assert.ok(lockAt < readyAt, "单实例守卫必须早于 whenReady：否则拿不到锁也会建出主窗口");
  assert.match(mainSource, /if \(!gotSingleInstanceLock\) return;/, "引导入口必须再挡一次拿不到锁的实例");
  assert.doesNotMatch(
    mainSource,
    /gotSingleInstanceLock[\s\S]{0,160}app\.quit\(\)/,
    "拿不到锁时必须 exit(0)：quit() 仍会走 ready 并闪出窗口",
  );
});
