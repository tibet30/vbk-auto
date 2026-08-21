export type AppAuthLoginErrorTarget = "credentials" | "captcha" | "form";

export interface AppAuthLoginError {
  message: string;
  target: AppAuthLoginErrorTarget;
}

const REMOTE_METHOD_PREFIX = /^Error invoking remote method\s+['"][^'"]+['"]:\s*/i;
const ERROR_PREFIX = /^Error:\s*/i;
const WRONG_CREDENTIALS = /(?:账号|用户名|手机号)(?:或|\/)(?:密码).*(?:错误|不正确)|(?:账号|用户名|手机号).*密码错误/i;
const INVALID_CAPTCHA = /验证码.*(?:错误|不正确|无效|失效|过期)|(?:错误|无效|失效|过期).*验证码/i;

/** Remove Electron's IPC wrapper while retaining the user-facing service message. */
export function appAuthErrorMessage(caught: unknown, fallback: string): string {
  const raw = caught instanceof Error ? caught.message : typeof caught === "string" ? caught : "";
  let message = raw.replace(/\s+/g, " ").trim();
  message = message.replace(REMOTE_METHOD_PREFIX, "");
  while (ERROR_PREFIX.test(message)) message = message.replace(ERROR_PREFIX, "");
  return message.trim() || fallback;
}

export function appAuthLoginError(caught: unknown): AppAuthLoginError {
  const message = appAuthErrorMessage(caught, "登录未成功，请稍后重试。");
  if (WRONG_CREDENTIALS.test(message)) {
    return { message: "手机号或密码不正确，请检查后重试。", target: "credentials" };
  }
  if (INVALID_CAPTCHA.test(message)) {
    return { message: "图形验证码不正确或已失效，请重新输入。", target: "captcha" };
  }
  return { message, target: "form" };
}
