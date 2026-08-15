#!/usr/bin/env node
// scripts/debug-step.mjs
//
// 单步调试自动化：在 Electron 主进程里运行具名 ctrip 步骤。
//
// 用法：
//   node scripts/debug-step.mjs snapshot
//   node scripts/debug-step.mjs selectStationAddress --cardSelector '...' --city 大同
//   node scripts/debug-step.mjs fillRecommendationReasons --product <id>
//   node scripts/debug-step.mjs fillItineraryDraft --product <id>
//   node scripts/debug-step.mjs run-step fillItineraryDraft '{"localProductId":"..."}' --break beforeFillItineraryDraft
//
// 选项：
//   --port <n>              CDP 端口（默认 9539，可用环境变量 VBK_CDP_PORT 覆盖）
//   --product <id>          产品 ID
//   --break name1,name2     本次运行要等用户输入的断点名（多个逗号分隔）
//   --break-on-all          命中所有断点时都停（不需要显式列名）
//   --auto                  非交互：命中断点后立即 continue；只用来观察命中记录
//   --label <text>          snapshot 的 label
//   --json <args>           给 runStep 的 JSON 参数
//
// 交互（TTY 下）：
//   continue                继续执行直到下一个断点
//   step                    等价于 continue（断点已是 step 粒度）
//   stop                    立即抛出终止后续执行
//   hit                     列出已命中断点
//   snapshot [label]        取当前 VBK 页面快照（JSON）
//   help                    显示可用命令
//   quit / exit             退出

import { chromium } from "playwright";

const args = parseArgs(process.argv.slice(2));
const PORT = args.port || process.env.VBK_CDP_PORT || 9539;
const STEP = args._[0];
const SUB_STEP = args._[1];

const cdpUrl = `http://127.0.0.1:${PORT}`;
const browser = await chromium.connectOverCDP(cdpUrl).catch((e) => {
  console.error(`连接 CDP ${cdpUrl} 失败：${e.message}`);
  console.error("确认 Electron 正在运行且 remote-debugging-port 已暴露。");
  process.exit(1);
});

const context = browser.contexts()[0];
const renderer = context.pages().find((p) => (p.url() || "").includes("127.0.0.1:5173"));
const vbk = context.pages().find((p) => (p.url() || "").includes("vbooking.ctrip.com"));
if (!renderer) {
  console.error("未找到渲染进程页面（127.0.0.1:5173）");
  process.exit(1);
}
const dismissNativeDialog = async (page) => {
  if (!page) return;
  try { page.removeAllListeners("dialog"); } catch {}
  page.on("dialog", async (dialog) => {
    try {
      await dialog.accept().catch(() => dialog.dismiss().catch(() => {}));
    } catch (error) {
      console.warn(`[debug-step] 自动处理 JS dialog 失败：${error instanceof Error ? error.message : String(error)}`);
    }
  });
};
dismissNativeDialog(renderer);
dismissNativeDialog(vbk);

const mode = (process.env.VBK_DEBUG_BREAKPOINTS ? args.break || process.env.VBK_DEBUG_BREAKPOINTS : args.break) || "";
const interactive = !!process.stdin.isTTY && !args.auto;

console.log(`[debug-step] CDP=${cdpUrl} mode=${mode || "(no breakpoints)"} interactive=${interactive}`);

if (STEP === "snapshot") {
  const result = await renderer.evaluate(async (label) => window.vbk.debug.snapshot(label), args.label || "manual");
  console.log(JSON.stringify(result, null, 2));
  await browser.close();
  process.exit(0);
}

if (STEP === "run-step") {
  // 透传到 automation.debug.runStep
  const stepName = SUB_STEP;
  const argsJson = args.json || "{}";
  const promise = renderer.evaluate(
    ({ stepName, argsJson }) => window.vbk.debug.runStep(stepName, argsJson),
    { stepName, argsJson },
  );
  if (interactive) {
    await interactiveLoop({ renderer, browser, pendingCall: promise });
  } else {
    const result = await promise;
    console.log("result:", JSON.stringify(result, null, 2));
  }
  await browser.close();
  process.exit(0);
}

if (STEP === "selectStationAddress" || STEP === "fillItineraryDraft" || STEP === "fillRecommendationReasons") {
  // 友好语法：把 --cardSelector / --city / --product 转成 argsJson
  const argsObj = {};
  if (args.cardSelector) argsObj.cardSelector = args.cardSelector;
  if (args.city) argsObj.city = args.city;
  if (args.product) argsObj.localProductId = args.product;
  const argsJson = JSON.stringify(argsObj);
  const promise = renderer.evaluate(
    ({ stepName, argsJson }) => window.vbk.debug.runStep(stepName, argsJson),
    { stepName: STEP, argsJson },
  );
  if (interactive) {
    await interactiveLoop({ renderer, browser, pendingCall: promise });
  } else {
    const result = await promise;
    console.log("result:", JSON.stringify(result, null, 2));
  }
  await browser.close();
  process.exit(0);
}

console.error(`未知命令：${STEP}。可用：snapshot / run-step <name> / selectStationAddress / fillItineraryDraft / fillRecommendationReasons`);
await browser.close();
process.exit(1);

async function interactiveLoop({ renderer, browser, pendingCall }) {
  console.log("[interactive] 进入交互模式；输入 continue/step/stop/snapshot/hit/quit。");
  // 后台 stdin 监听
  let pendingResolve = null;
  let pendingReject = null;
  const commandQueue = [];
  let resolveNext = null;
  const nextCommand = () => new Promise((r) => { resolveNext = r; });

  const onLine = (line) => {
    const cmd = line.trim().toLowerCase();
    if (!cmd) return;
    if (cmd === "quit" || cmd === "exit") {
      process.exit(0);
    }
    if (resolveNext) {
      const r = resolveNext;
      resolveNext = null;
      r(cmd);
    } else {
      commandQueue.push(cmd);
    }
  };
  process.stdin.setRawMode(false);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", onLine);
  process.stdout.write("> ");

  // 主动汇报命中点
  let lastHit = 0;
  const watcher = setInterval(async () => {
    try {
      const hits = await renderer.evaluate(() => window.vbk.debug.hitBreakpoints());
      if (hits.length > lastHit) {
        const newOnes = hits.slice(lastHit);
        for (const h of newOnes) {
          console.log(`\n[bp-hit] ${h}`);
          // 取快照（轻度）
          const snap = await renderer.evaluate(() => window.vbk.debug.snapshot(`bp:${h}`));
          console.log(`         url=${snap.url} btns=${snap.visibleButtons.length} dialogs=${snap.visibleDialogs.length} errs=${snap.formErrors.length}`);
        }
        lastHit = hits.length;
        process.stdout.write("> ");
      }
    } catch {}
  }, 500);

  const result = await pendingCall;
  clearInterval(watcher);
  console.log("\nresult:", JSON.stringify(result, null, 2));
  process.stdin.removeListener("data", onLine);
  process.stdin.pause();
}

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
