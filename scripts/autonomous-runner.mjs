// 自动循环：直到所有 phase 都 completed 或 readiness 满。
// 每次循环：查 DB 状态 → 若 failed 触发 retry → 等到状态稳定 → 再查。
// 失败时打印 attempt 错误摘要，方便后续 session 接力。

import Database from "better-sqlite3";
import { chromium } from "playwright";
import { execSync, spawn } from "node:child_process";

const args = parseArgs(process.argv.slice(2));
const PROJECT_ID = args.project || process.env.VBK_PROJECT_ID;
const DB_PATH = `${process.env.HOME}/Library/Application Support/vbk-auto/vbk-desktop.sqlite`;
const CDP_PORT = Number(args.port || process.env.VBK_CDP_PORT || 9837);

function getState() {
  const db = new Database(DB_PATH, { readonly: true });
  try {
    const run = db.prepare(
      "SELECT id, payload_json, created_at FROM automation_runs WHERE project_id=? ORDER BY created_at DESC LIMIT 1"
    ).get(PROJECT_ID);
    const proj = db.prepare(
      "SELECT status, product_id, updated_at FROM projects WHERE id=?"
    ).get(PROJECT_ID);
    if (!run) return null;
    const payload = JSON.parse(run.payload_json || "{}");
    return { runId: run.id, runStatus: payload.status, currentPhase: payload.currentPhase, phases: payload.phases || [], recovery: payload.recovery, project: proj, payload, createdAt: run.created_at };
  } finally {
    db.close();
  }
}

async function triggerRetry(retryFromPhase) {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
  try {
    const ctx = browser.contexts()[0];
    const renderer = ctx.pages().find((p) => (p.url() || "").includes("127.0.0.1:5173"));
    if (!renderer) throw new Error("未找到渲染进程页面");
    // 跳过所有 dialog — 这避免 “Page.handleJavaScriptDialog: No dialog is showing” 报错
    // （之前测试脚本装的 handler 被 connectOverCDP 重新拾起但 dialog 已关）。
    renderer.on("dialog", (d) => d.accept().catch(() => {}));
    for (const p of ctx.pages()) {
      try { p.removeAllListeners("dialog"); } catch {}
      p.on("dialog", (d) => d.accept().catch(() => {}));
    }
    const res = await renderer.evaluate(
      ({ id, phase }) => phase ? window.vbk.automation.retryPhase(id, phase) : window.vbk.automation.retry(id),
      { id: PROJECT_ID, phase: retryFromPhase }
    );
    return res;
  } finally {
    await browser.close().catch(() => {});
  }
}

async function ensureCdp() {
  // 给 Electron 一点时间暴露 CDP
  for (let i = 0; i < 30; i++) {
    try {
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
      const ctx = browser.contexts()[0];
      const renderer = ctx.pages().find((p) => (p.url() || "").includes("127.0.0.1:5173"));
      if (renderer) {
        await browser.close().catch(() => {});
        return true;
      }
      await browser.close().catch(() => {});
    } catch {}
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

function findFailedPhase(state) {
  // 优先按 phase.status 找 failed，再看 recovery.state === "needs_user"
  const failedByPhase = state.phases.find((p) => p.status === "failed");
  if (failedByPhase) return failedByPhase.phase;
  if (state.recovery?.phases) {
    const needs = Object.values(state.recovery.phases).find((rec) => rec.state === "needs_user");
    if (needs) return needs.phase;
  }
  return state.currentPhase && state.runStatus === "failed" ? state.currentPhase : null;
}

async function waitForStable(prevState, maxMs = 240_000) {
  const start = Date.now();
  let last = prevState;
  while (Date.now() - start < maxMs) {
    await new Promise((r) => setTimeout(r, 5000));
    const cur = getState();
    if (!cur) continue;
    // 状态变化 = 有进展或失败
    const sig = (s) => `${s.runStatus}|${s.currentPhase}|${(s.phases || []).map((p) => `${p.phase}:${p.status}`).join(",")}`;
    if (sig(cur) !== sig(last)) return cur;
    last = cur;
  }
  return last;
}

function describeAttemptErrors(state) {
  const out = [];
  if (!state.recovery?.phases) return out;
  for (const [phase, rec] of Object.entries(state.recovery.phases)) {
    for (const att of rec.attempts || []) {
      if (att.error) out.push(`[${phase}] ${att.action || "-"}: ${String(att.error).slice(0, 250)}`);
    }
  }
  return out;
}

async function main() {
  if (!PROJECT_ID) {
    console.error("缺少 PROJECT_ID。请用 --project <id> 或环境变量 VBK_PROJECT_ID 指定。");
    console.error("示例: node scripts/autonomous-runner.mjs --project <uuid> --port 9330");
    process.exit(1);
  }
  console.log(`[runner] CDP=${CDP_PORT} PROJECT=${PROJECT_ID}`);

  const cdpOk = await ensureCdp();
  if (!cdpOk) {
    console.error("[runner] CDP 不可用，确认 Electron 启动且 remote-debugging-port=${CDP_PORT}");
    process.exit(1);
  }

  for (let iter = 0; iter < 50; iter++) {
    const state = getState();
    if (!state) { console.log("[runner] 无 automation_run，结束"); return; }
    console.log(`\n[iter ${iter}] status=${state.runStatus} phase=${state.currentPhase}`);
    for (const p of state.phases) console.log(`  ${p.phase}: ${p.status}`);

    // 全 completed？
    const allDone = state.phases.every((p) => p.status === "completed" || p.status === "skipped");
    if (allDone && state.runStatus === "completed") {
      console.log("[runner] 所有阶段 completed，结束");
      return;
    }
    if (state.runStatus === "completed") {
      console.log("[runner] run.status=completed，结束");
      return;
    }

    const failed = findFailedPhase(state);
    if (!failed) {
      console.log("[runner] 无失败阶段可重试，可能已结束");
      return;
    }

    console.log(`[runner] 触发 retry from ${failed}…`);
    try {
      const res = await triggerRetry(failed);
      console.log("[runner] retry start result:", JSON.stringify(res));
    } catch (e) {
      console.log(`[runner] retry 触发失败：${e.message}`);
      await new Promise((r) => setTimeout(r, 8000));
      continue;
    }

    const next = await waitForStable(state);
    console.log(`[runner] 稳定后 status=${next.runStatus} phase=${next.currentPhase}`);
    const errs = describeAttemptErrors(next);
    if (errs.length) {
      console.log("[runner] 本轮错误：");
      for (const e of errs.slice(-3)) console.log("  -", e);
    }
  }
  console.log("[runner] 达到最大迭代次数，结束");
}

main().catch((e) => { console.error(e); process.exit(1); });

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) {
        out[key] = true;
      } else {
        out[key] = next;
        i++;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}