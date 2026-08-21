import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (file: string) => fs.readFileSync(file, "utf8");
const root = read("src/renderer/app/app.main.tsx");
const login = read("src/renderer/app/auth/LoginPage.tsx");
const service = read("src/main/infrastructure/tibet-auth.ts");
const ipc = read("src/main/ipc/app-auth-ipc.ts");

test("应用根节点先通过 app auth gate，认证后才挂载现有工作台", () => {
  assert.match(root, /auth\.phase\s*!==\s*"authenticated"/);
  assert.match(root, /<AppLoginPage\s+controller=\{auth\}/);
  assert.match(root, /<AuthenticatedWorkspace\s+key=\{auth\.user\?\.id\}\s*\/>/);
});

test("切换应用账号会清理上一账号的产品恢复指针并重挂工作台", () => {
  const context = read("src/renderer/app/auth/AppAuthContext.tsx");
  assert.match(context, /await bridge\.appAuth\.switchAccount\(userId\)/);
  assert.match(context, /localStorage\.removeItem\("vbk:activeLocalProductId"\)/);
  assert.match(root, /key=\{auth\.user\?\.id\}/);
});

test("登录页明确区分应用账号与 VBK 账号，并具备验证码刷新和错误恢复", () => {
  assert.match(login, /应用账号/);
  assert.match(login, /VBK 账号/);
  assert.match(login, /bridge\.appAuth\.captcha\(\)/);
  assert.match(login, /await loadCaptcha\(\)/);
  assert.match(login, /role="alert"/);
  assert.match(login, /controller\.accounts\.saved\.map/);
  assert.match(login, /await controller\.switchAccount\(userId\)/);
  assert.match(login, /可直接进入，无需密码/);
});

test("renderer 永远拿不到 token，认证请求仅存在于 main 进程服务", () => {
  assert.doesNotMatch(login, /\.token\b|access_token/);
  assert.match(service, /Authorization: `Bearer \$\{session\.token\}`/);
  assert.match(service, /store\.set\(\{ token, expiresAt, user \}\)/);
  assert.match(ipc, /secureIpcMain as ipcMain/);
});
