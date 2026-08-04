/**
 * 调试 helper：断点 + 快照 + 步进控制。
 *
 * 设计目标：
 * - 生产环境（无 VBK_DEBUG 环境变量）：所有 helper 退化为 no-op 或纯日志，
 *   不影响正常 automation 流程，不引入额外开销。
 * - 开发环境（设置 VBK_DEBUG=1 或 VBK_DEBUG_BREAKPOINTS=<name>）：
 *   - breakpoint(name) 会打印 name + context，等用户从 stdin 输入 continue/step。
 *   - snapshot(page) 会把当前 VBK 页面关键 DOM / URL / console 错误落 JSON。
 *   - 单步模式下用 VBK_DEBUG_STEP=1 实现「执行到下一个断点」。
 *
 * CLI 调用方：scripts/debug-step.mjs 通过 stdin 控制 pause/resume，
 * 让开发者可以在 IDE 终端里像 gdb 一样走完整个 automation。
 */

import type { Page } from "playwright";

type DebugSnapshot = {
  at: string;
  url: string;
  title: string;
  visibleButtons: string[];
  visibleTabs: Array<{ text: string; selected: boolean; disabled: boolean }>;
  visibleDialogs: Array<{ title: string; text: string }>;
  formErrors: string[];
  recommendationRows: number;
  pageErrors: string[];
};

const isDebug = () => process.env.VBK_DEBUG === "1" || !!process.env.VBK_DEBUG_BREAKPOINTS;
const breakpointEnv = () => (process.env.VBK_DEBUG_BREAKPOINTS || "").split(",").map((s) => s.trim()).filter(Boolean);

/** CLI 用：查询当前配置的断点列表（来源：env VBK_DEBUG_BREAKPOINTS）。 */
export function listBreakpoints(): string[] {
  return breakpointEnv();
}

let pendingResume: { resolve: () => void } | null = null;
let stopRequested = false;
const hitBreakpoints: string[] = [];

function pauseForUser(name: string, context: unknown) {
  const ctx = context ? `\n  context: ${JSON.stringify(context).slice(0, 800)}` : "";
  process.stderr.write(`\n[breakpoint] ${name}${ctx}\n> `);
  pendingResume = { resolve: () => {} };
  stopRequested = false;
  return new Promise<void>((resolve) => {
    pendingResume!.resolve = () => {
      pendingResume = null;
      resolve();
    };
  });
}

/**
 * 在关键节点埋的断点。production: log + return。debug: 打印 + 等用户输入。
 * 控制命令：continue / step / stop / state / snapshot。
 */
export async function breakpoint(name: string, context?: unknown): Promise<void> {
  // 不管是不是 debug 模式，都记录命中点 — 用于事后审计 “代码走到了哪些节点”。
  hitBreakpoints.push(name);
  if (!isDebug()) return;
  if (breakpointEnv().length && !breakpointEnv().includes(name)) return;
  process.stderr.write(`[bp:${name}]`);
  if (!process.stdin.isTTY) {
    // 非 TTY 环境（自动化跑）下无法交互，仍然 log + 立即返回，
    // 避免阻塞。CLI 通过 stdin 触发 pause/resume。
    return;
  }
  await pauseForUser(name, context);
}

/** 立即抛出，停止后续执行；CLI 用 stop 命令触发。 */
export function isStopRequested(): boolean {
  return stopRequested;
}

/** CLI 用：通过 stdin 输入 "continue"/"step"/"stop" 来控制。 */
export function resume(command: "continue" | "step" | "stop") {
  if (command === "stop") {
    stopRequested = true;
    if (pendingResume) pendingResume.resolve();
    return { stopped: true };
  }
  // continue / step 同时重置 stop 标志：发 continue 代表用户已决定重启。
  stopRequested = false;
  if (pendingResume) pendingResume.resolve();
  return { stopped: false };
}

/** 拿当前页面的可序列化快照，便于离线排查 / 写回归 fixture。 */
export async function snapshot(page: Page, label = "snapshot"): Promise<DebugSnapshot> {
  const at = new Date().toISOString();
  const data = await page.evaluate(() => {
    const visible = (el: HTMLElement) => el.offsetParent !== null;
    return {
      url: location.href,
      title: document.title,
      visibleButtons: Array.from(document.querySelectorAll("button"))
        .filter((b) => visible(b as HTMLElement))
        .map((b) => (b.textContent || "").trim().replace(/\s+/g, ""))
        .filter((t) => t)
        .slice(0, 50),
      visibleTabs: Array.from(document.querySelectorAll('[role="tab"]'))
        .filter((t) => visible(t as HTMLElement))
        .map((t) => ({
          text: (t.textContent || "").trim(),
          selected: t.getAttribute("aria-selected") === "true",
          disabled: t.getAttribute("aria-disabled") === "true",
        })),
      visibleDialogs: Array.from(document.querySelectorAll('.ant-modal, [role="dialog"]'))
        .filter((d) => visible(d as HTMLElement))
        .map((d) => ({
          title: (d.querySelector('.ant-modal-title')?.textContent || "").trim(),
          text: (d.textContent || "").trim().slice(0, 400),
        })),
      formErrors: Array.from(document.querySelectorAll(".ant-form-item-explain-error"))
        .map((e) => (e.textContent || "").trim())
        .filter((t) => t && t.length < 200)
        .slice(0, 20),
      recommendationRows: document.querySelectorAll("#pm_recommend .ant-form-item").length,
      pageErrors: ((window as unknown as { __pageErrors?: string[] }).__pageErrors || []),
    };
  });
  const snap = { at, label, ...data } as DebugSnapshot & { label: string };
  if (isDebug()) {
    process.stderr.write(`[snapshot:${label}] url=${data.url} btns=${data.visibleButtons.length} dialogs=${data.visibleDialogs.length} errs=${data.formErrors.length}\n`);
  }
  return snap;
}

/** CLI 用：列出本次跑过的所有断点。 */
export function getHitBreakpoints(): readonly string[] {
  return hitBreakpoints;
}

/** 重置命中记录（每次 run 前调一次）。 */
export function resetBreakpoints(): void {
  hitBreakpoints.length = 0;
  stopRequested = false;
  pendingResume?.resolve();
  pendingResume = null;
}