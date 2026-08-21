import test from "node:test";
import assert from "node:assert/strict";
import { appAuthErrorMessage, appAuthLoginError } from "../../src/renderer/app/auth/app-auth-error.js";

test("登录错误移除 Electron IPC 前缀并改写为可操作的中文提示", () => {
  const error = new Error("Error invoking remote method 'appAuth:login': Error: 账号或密码错误");
  assert.deepEqual(appAuthLoginError(error), {
    message: "手机号或密码不正确，请检查后重试。",
    target: "credentials",
  });
});

test("验证码错误明确提示重新输入并只标记验证码字段", () => {
  const error = new Error("Error invoking remote method 'appAuth:login': Error: 验证码已过期");
  assert.deepEqual(appAuthLoginError(error), {
    message: "图形验证码不正确或已失效，请重新输入。",
    target: "captcha",
  });
});

test("其它账号服务消息保留业务含义但不暴露 remote method", () => {
  const error = new Error("Error invoking remote method 'appAuth:login': Error: 账号已停用，请联系管理员");
  const result = appAuthLoginError(error);
  assert.deepEqual(result, { message: "账号已停用，请联系管理员", target: "form" });
  assert.doesNotMatch(result.message, /remote method|appAuth:login|Error:/i);
});

test("无法识别的异常使用安全兜底", () => {
  assert.equal(appAuthErrorMessage({ reason: "unknown" }, "登录未成功，请稍后重试。"), "登录未成功，请稍后重试。");
});
