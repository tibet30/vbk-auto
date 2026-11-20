// 智能体界面错误文案：剥掉 IPC / SDK 前缀、只给中文说明，并把「下一步」写进提示。
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import {
  agentWorkspaceError,
  agentWorkspaceErrorMessage,
} from "../../src/renderer/app/views/agent/workspace-error.js";

test("剥掉 Electron IPC 包装与 Error 前缀，保留业务文案", () => {
  const caught = new Error("Error invoking remote method 'agentWorkspace:send': Error: 当前任务仍在处理中，请稍候。");
  assert.equal(agentWorkspaceErrorMessage(caught, "任务执行失败。"), "当前任务仍在处理中，请稍候。");
});

test("夹带 SDK 错误名的中文提示同样能还原", () => {
  const caught = new Error("Error invoking remote method 'agentWorkspace:resume': AI_NoOutputGeneratedError: 模型这次没有返回任何内容。");
  assert.equal(agentWorkspaceErrorMessage(caught, "任务执行失败。"), "模型这次没有返回任何内容。");
});

test("纯英文技术错误不直接进界面，退回调用方的中文兜底", () => {
  const caught = new Error("Error invoking remote method 'agentWorkspace:send': AI_NoOutputGeneratedError: No output generated. Check the stream for errors.");
  assert.equal(agentWorkspaceErrorMessage(caught, "任务执行失败。"), "任务执行失败。");
  assert.equal(agentWorkspaceErrorMessage(undefined, "无法加载智能体任务。"), "无法加载智能体任务。");
});

test("空响应错误附带「继续运行」的下一步提示", () => {
  const failure = agentWorkspaceError(new Error("模型这次没有返回任何内容，本次运行已暂停。"), "任务执行失败。");
  assert.equal(failure.message, "模型这次没有返回任何内容，本次运行已暂停。");
  assert.match(failure.hint ?? "", /继续运行/u);
});

test("鉴权与限流给出各自的处理建议", () => {
  assert.match(agentWorkspaceError(new Error("模型服务鉴权失败，请到设置里检查 API Key 是否有效。"), "x").hint ?? "", /API Key/u);
  assert.match(agentWorkspaceError(new Error("模型服务请求过于频繁，请稍等片刻再重试。"), "x").hint ?? "", /等十几秒/u);
  assert.equal(agentWorkspaceError(new Error("无法删除任务。"), "x").hint, undefined);
});

test("智能体界面不再直接展示原始 IPC 错误", () => {
  const directory = path.join(process.cwd(), "src/renderer/app/views/agent");
  const offenders = fs.readdirSync(directory)
    .filter((file) => /\.tsx?$/u.test(file))
    .filter((file) => /reason\s+instanceof\s+Error\s*\?\s*reason\.message/u.test(fs.readFileSync(path.join(directory, file), "utf8")));
  assert.deepEqual(offenders, [], "错误展示统一走 agentWorkspaceError，禁止把 reason.message 直接塞进界面");
});
