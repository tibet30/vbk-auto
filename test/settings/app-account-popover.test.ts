import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(path, "utf8");
const rail = read("src/renderer/app/views/shell/Rail.tsx");
const popover = read("src/renderer/app/views/shell/AppAccountPopover.tsx");

test("侧栏头像展示当前应用平台用户，不再绑定 VBK 账号", () => {
  assert.match(rail, /const\s+\{\s*user,\s*accounts,\s*switchAccount,\s*startLogin,\s*logout\s*\}\s*=\s*useAppAuth\(\)/);
  assert.match(rail, /aria-label=\{`当前登录用户：\$\{appUserName\}`\}/);
  assert.match(rail, /<AppAccountPopover[\s\S]*?user=\{user\}[\s\S]*?savedAccounts=\{accounts\.saved\}/);
  assert.doesNotMatch(rail, /<AccountPopover|onAddLogin|addNewLogin/);
});

test("应用账号菜单列出历史账号并允许免密码切换", () => {
  assert.match(popover, /当前登录用户/);
  assert.match(popover, /以前登录过/);
  assert.match(popover, /免输密码切换/);
  assert.match(popover, /onSwitchAccount\(account\.user\.id\)/);
  assert.match(popover, /登录其他账号/);
  assert.match(popover, /退出当前账号/);
  assert.doesNotMatch(popover, /查看登录面板|登录 VBK/);
});

test("切换复用历史会话，登录其他账号才进入新登录流程", () => {
  assert.match(rail, /onSwitchAccount=\{async \(userId\)[\s\S]*?await switchAccount\(userId\)/);
  assert.match(rail, /onStartLogin=\{startLogin\}/);
  assert.match(rail, /onLogout=\{logout\}/);
  assert.match(rail, /const\s+\[appAccountMenuOpen,\s*setAppAccountMenuOpen\]/);
  assert.match(rail, /setAccountMenuOpen\(false\);[\s\S]*?setAppAccountMenuOpen\(\(open\)\s*=>\s*!open\)/);
});
