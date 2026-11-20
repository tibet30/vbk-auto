// 智能体界面的错误呈现：剥掉 IPC 与 SDK 包装前缀，把剩下的文案配上一句可执行的下一步。
export interface AgentWorkspaceError {
  message: string;
  hint?: string;
}

const REMOTE_METHOD_PREFIX = /^Error invoking remote method\s+['"][^'"]+['"]:\s*/i;
const ERROR_PREFIX = /^(?:Error:\s*)+/i;
const CODE_PREFIX = /^(?:AI_[A-Za-z0-9_]+Error|[A-Z][A-Za-z0-9_]*Error):\s*/;
const CHINESE = /[\u4e00-\u9fff]/u;

const HINTS: Array<{ pattern: RegExp; hint: string }> = [
  {
    pattern: /没有返回任何内容|响应为空/,
    hint: "运行已暂停：再发一次消息，或在运行面板点「继续运行」重试；反复出现再检查模型服务与网络。",
  },
  { pattern: /鉴权失败|API Key/i, hint: "请到设置里重新填写并保存模型 API Key 后再试。" },
  { pattern: /过于频繁/, hint: "等十几秒再继续运行即可，这不是配置问题。" },
  { pattern: /暂时不可用/, hint: "稍后点「继续运行」重试；持续失败说明模型服务当前异常。" },
  { pattern: /超时/, hint: "先重试一次；连续超时请检查网络或代理设置。" },
  { pattern: /连不上/, hint: "检查网络与代理设置，确认能访问模型服务后重试。" },
  { pattern: /上下文超出/, hint: "这个任务的上下文已经太长，可新建任务继续，或在任务里精简记录。" },
  { pattern: /审核拦截/, hint: "按提示改写措辞后再发送，模型会重新处理。" },
];

export function agentWorkspaceErrorMessage(caught: unknown, fallback: string): string {
  const raw = caught instanceof Error ? caught.message : typeof caught === "string" ? caught : "";
  let text = raw.replace(/\s+/gu, " ").trim();
  text = text.replace(REMOTE_METHOD_PREFIX, "").replace(ERROR_PREFIX, "").replace(CODE_PREFIX, "").trim();
  if (!text || !CHINESE.test(text)) return fallback;
  return text;
}

export function agentWorkspaceError(caught: unknown, fallback: string): AgentWorkspaceError {
  const message = agentWorkspaceErrorMessage(caught, fallback);
  const hint = HINTS.find((entry) => entry.pattern.test(message))?.hint;
  return hint ? { message, hint } : { message };
}
