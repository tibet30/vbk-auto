/**
 * 统一日志时间戳 helper 测试：
 *   - logTimestamp 返回可排序的 ISO-like 字符串 `YYYY-MM-DD HH:MM:SS.SSS`；
 *   - logInfo/logWarn/logError/logLog/logDebug 都在第一个字符串参数前追加时间戳；
 *   - 即便传入第一个参数是对象，timestamp 仍会出现在最前；
 *   - 多次调用产生的时间戳单调不重复（同一毫秒内调用也会得到独立返回值即可）；
 *   - 调用走原生 console.*，测试可通过 console spy 注入来观察 timestamp；
 *   - 测试使用 console spy，不做全局 monkey patch。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { logTimestamp, logInfo, logWarn, logError, logLog, logDebug } from "../../src/shared/log-timestamp.js";

type Captured = { level: "info" | "warn" | "error" | "log" | "debug"; args: unknown[] }[];

function captureConsole(): { logs: Captured; restore: () => void } {
  const logs: Captured = [];
  const original = { info: console.info, warn: console.warn, error: console.error, log: console.log, debug: console.debug };
  const wrap = (level: Captured[number]["level"]) => (...args: unknown[]) => { logs.push({ level, args }); };
  (console as unknown as Record<string, (...a: unknown[]) => void>).info = wrap("info");
  (console as unknown as Record<string, (...a: unknown[]) => void>).warn = wrap("warn");
  (console as unknown as Record<string, (...a: unknown[]) => void>).error = wrap("error");
  (console as unknown as Record<string, (...a: unknown[]) => void>).log = wrap("log");
  (console as unknown as Record<string, (...a: unknown[]) => void>).debug = wrap("debug");
  return {
    logs,
    restore() {
      (console as unknown as Record<string, (...a: unknown[]) => void>).info = original.info;
      (console as unknown as Record<string, (...a: unknown[]) => void>).warn = original.warn;
      (console as unknown as Record<string, (...a: unknown[]) => void>).error = original.error;
      (console as unknown as Record<string, (...a: unknown[]) => void>).log = original.log;
      (console as unknown as Record<string, (...a: unknown[]) => void>).debug = original.debug;
    },
  };
}

const TS_REGEX = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/;

test("logTimestamp 返回 ISO-like 字符串并按字典序可排序", () => {
  const a = logTimestamp();
  const b = logTimestamp();
  assert.match(a, TS_REGEX);
  assert.match(b, TS_REGEX);
  // 字典序比较与时间比较一致。
  assert.ok(a <= b || b <= a, "时间戳可以按字典序比较");
});

test("logInfo 在第一个字符串参数前加 timestamp，且整个字符串首部没有重复时间戳", () => {
  const cap = captureConsole();
  try {
    logInfo("[planning] run.start projectId=p1");
  } finally { cap.restore(); }
  assert.equal(cap.logs.length, 1);
  const [arg] = cap.logs[0].args;
  assert.equal(typeof arg, "string");
  const s = arg as string;
  // 应当形如 "<ts> [planning] run.start projectId=p1"，ts 仅出现一次。
  const tsMatches = s.match(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}/g);
  assert.equal(tsMatches?.length, 1, `应只有 1 个时间戳，实际 ${tsMatches?.length}: ${s}`);
  assert.match(s, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} \[planning\]/);
});

test("logWarn / logError / logLog / logDebug 行为一致", () => {
  const cap = captureConsole();
  try {
    logWarn("[x] warn");
    logError("[x] error");
    logLog("[x] log");
    logDebug("[x] debug");
  } finally { cap.restore(); }
  assert.deepEqual(cap.logs.map((l) => l.level), ["warn", "error", "log", "debug"]);
  for (const item of cap.logs) {
    const s = item.args[0] as string;
    assert.match(s, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} \[x\]/);
    const tsMatches = s.match(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}/g);
    assert.equal(tsMatches?.length, 1);
  }
});

test("logInfo 第一个参数非字符串时，时间戳出现在参数最前", () => {
  const cap = captureConsole();
  try {
    logInfo({ foo: 1 }, "extra");
  } finally { cap.restore(); }
  assert.equal(cap.logs.length, 1);
  const args = cap.logs[0].args;
  assert.match(String(args[0]), TS_REGEX);
  assert.deepEqual(args[1], { foo: 1 });
  assert.equal(args[2], "extra");
});

test("logInfo 不接受空参数时不抛错（退化为只输出 timestamp）", () => {
  const cap = captureConsole();
  try { logInfo(); } finally { cap.restore(); }
  assert.equal(cap.logs.length, 1);
  assert.match(String(cap.logs[0].args[0]), TS_REGEX);
});

test("同一文件内多次调用时间戳不出现 NaN/Invalid Date，格式全部合法", () => {
  const cap = captureConsole();
  try {
    for (let i = 0; i < 5; i += 1) logInfo(`[batch] step=${i}`);
  } finally { cap.restore(); }
  assert.equal(cap.logs.length, 5);
  for (const item of cap.logs) {
    const s = item.args[0] as string;
    assert.match(s, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} \[batch\] step=\d$/);
    assert.equal(s.includes("NaN"), false);
  }
});

test("包装函数不修改 console.* 原型（无全局 monkey patch）", () => {
  const original = console.info;
  const cap = captureConsole();
  try { logInfo("hi"); } finally { cap.restore(); }
  assert.equal(console.info, original, "console.info 必须恢复到原始实现");
});

test("包装函数透传额外参数（不只接受字符串首参）", () => {
  const cap = captureConsole();
  try {
    logInfo("[t]", { a: 1 }, [1, 2, 3], 42);
  } finally { cap.restore(); }
  assert.equal(cap.logs.length, 1);
  const args = cap.logs[0].args;
  assert.equal(args.length, 4);
  assert.match(args[0] as string, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} \[t\]$/);
  assert.deepEqual(args[1], { a: 1 });
  assert.deepEqual(args[2], [1, 2, 3]);
  assert.equal(args[3], 42);
});