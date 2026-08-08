// 回归契约测试：保证 useAppStateBase 内 refreshVbkLoginAccounts 仍由 useCallback
// 持有稳定引用，并保证 settings/vbk-login-block.tsx 的对应 effect / 「新增登录」按钮
// 仍然把该引用纳入依赖、把 loadingLoginAccounts 纳入 disabled 表达式。
//
// 根因：refreshVbkLoginAccounts 一旦从 useCallback 退回到普通 `async () => {...}`，
// 每次 render 都生成新闭包；vbk-login-block 的 effect 把它放进 deps，会跟随重跑；
// effect 体内 setLoadingLoginAccounts(true) 同步触发再 render，又得到新闭包 →
// setState 循环 → 「新增登录」按钮 disabled 永远为 true。
//
// 之所以用「静态契约」而不是「真渲染测试」：
//   - 仓库 test infra 是 `node:test + tsx`，没有任何 React Testing Library / jsdom；
//   - useAppStateBase 顶层直接读 window.vbk / localStorage，导入就需要全局垫片；
//   - 真正驱动一个无限循环的场景需要 React reconciler 和 fake timers，
//     反而不如源码级契约直接命中本次回归。
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");

function read(relPath: string): string {
  return readFileSync(path.join(repoRoot, relPath), "utf8");
}

const baseSrc = read("src/renderer/app/state/base.ts");
const blockSrc = read("src/renderer/app/views/settings/vbk-login-block.tsx");

test("refreshVbkLoginAccounts 由 useCallback 包装且 deps 为空，跨 render 引用稳定", () => {
  // 必须形如：const refreshVbkLoginAccounts = useCallback(async () => { ... }, []);
  // 允许函数体内部任意空白 / 换行 / 注释，但尾部 deps 数组必须是空的。
  const decl = baseSrc.match(
    /const\s+refreshVbkLoginAccounts\s*=\s*useCallback\s*\(\s*async\s*\(\s*\)\s*=>\s*\{[\s\S]*?\}\s*,\s*\[\s*\]\s*\)/
  );
  assert.ok(
    decl,
    "refreshVbkLoginAccounts 必须用 useCallback(..., []) 持有稳定引用；"
    + "如果退回普通 async 箭头函数，vbk-login-block 的 effect 会形成 setState 循环，"
    + "「新增登录」按钮因 loadingLoginAccounts 长期为 true 而 disabled。"
  );
});

test("vbk-login-block 的 effect 把 refreshVbkLoginAccounts 放进 deps", () => {
  // 必须形如：useEffect(() => { void refreshVbkLoginAccounts(); }, [refreshVbkLoginAccounts, vbkLogin?.loggedIn]);
  // deps 列表里出现 refreshVbkLoginAccounts 是这次「稳定引用」契约生效的前置条件：
  // 如果 effect 不依赖它，useCallback 的稳定性也无从验证；如果连这个 effect 都没了，
  // 已记录账号列表永远不会刷新。
  const effect = blockSrc.match(
    /useEffect\s*\(\s*\(\s*\)\s*=>\s*\{\s*void\s+refreshVbkLoginAccounts\s*\(\s*\)\s*;\s*\}\s*,\s*\[\s*refreshVbkLoginAccounts\s*(?:,\s*vbkLogin\?\.loggedIn\s*)?\]\s*\)/
  );
  assert.ok(
    effect,
    "vbk-login-block 必须存在 useEffect 依赖 refreshVbkLoginAccounts 的刷新入口；"
    + "缺少依赖会导致账号列表永远不刷新，或与 setLoadingLoginAccounts(true) 形成 setState 循环。"
  );
});

test("「新增登录」按钮的 disabled 包含 loadingLoginAccounts，避免 effect 循环时按钮永久卡死", () => {
  // 「登录 VBK」（未登录态）按钮只有 disabled={checkingVbkLogin}，
  // 因此只看字符串 disabled={checkingVbkLogin} 不够 —— 必须锁定到「新增登录」按钮上下文。
  // 文件中「新增登录」字样也会出现在注释里，必须锚定到 JSX 中的 <PlugZap ... /> 新增登录
  // 才能唯一定位到那个真实的 button 节点。
  const newLoginIdx = blockSrc.indexOf("<PlugZap size={14} /> 新增登录");
  assert.notEqual(newLoginIdx, -1, "设置页必须存在「新增登录」按钮（JSX）");

  // 取「新增登录」之前最近的 <button ...> 起始位置，截取到「新增登录」为止；
  // 这样只关心同一个 button 的属性，不会误抓别的按钮。
  const before = blockSrc.slice(0, newLoginIdx);
  const openIdx = before.lastIndexOf("<button");
  assert.notEqual(openIdx, -1, "「新增登录」之前必须存在 <button 起始标签");
  const buttonAttrs = before.slice(openIdx);

  // 「新增登录」按钮的 disabled 必须显式带上 loadingLoginAccounts；
  // 一旦表达式退化为 disabled={checkingVbkLogin}，effect 循环期间按钮会被锁住。
  const disabledMatches = buttonAttrs.match(/disabled=\{([^}]+)\}/g) ?? [];
  assert.ok(
    disabledMatches.length > 0,
    "「新增登录」按钮必须有 disabled={...} 属性"
  );
  const disabledExpr = disabledMatches[disabledMatches.length - 1];
  assert.match(
    disabledExpr,
    /checkingVbkLogin\s*\|\|\s*loadingLoginAccounts/,
    "「新增登录」按钮的 disabled 必须包含 loadingLoginAccounts；"
    + "缺少该项会导致 effect setState 循环期间按钮被永久锁死。"
  );
});