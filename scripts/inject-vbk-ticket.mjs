#!/usr/bin/env node
// scripts/inject-vbk-ticket.mjs
//
// 把 vbkticket 直接写入 .data/chrome-profile/Default/Cookies（持久化 Chromium 用的
// cookie SQLite 库）。Chromium 启动时通过自己的 OSCrypt（macOS 走 Keychain）加密
// 落盘；落盘后 launchVbkBrowser / Electron 嵌入浏览器都会以已登录态进入 vbooking。
//
// 用法（任选其一）：
//   node scripts/inject-vbk-ticket.mjs                 从 .env 读 VBK_TICKET
//   VBK_TICKET=... node scripts/inject-vbk-ticket.mjs  从环境变量读
//   node scripts/inject-vbk-ticket.mjs <ticket>       直接传值
//
// 副作用：
//   - .data/chrome-profile/Default/Cookies 多一条 vbkticket 行（encrypted_value
//     由 Chromium 自己加密，不需要也不应该手动写）；
//   - 不动 .env、不动 login_sessions（那张表需要 safeStorage，要 Electron）；
//   - 不动任何源代码。
//
// 退出码：
//   0  注入成功且验证通过（页面看到「产品列表」）；
//   1  注入失败（参数缺失 / 浏览器启动失败 / cookie 写入抛错）；
//   2  注入成功但验证失败（页面被重定向 login，ticket 被服务端作废）。

import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const PROFILE_DIR = path.join(ROOT, ".data", "chrome-profile");
const LIST_URL = "https://vbooking.ctrip.com/product/input/productListMerge?from=vbk";

async function readTicket() {
  const cli = process.argv[2];
  if (cli) return { ticket: cli.trim(), source: "argv[2]" };
  if (process.env.VBK_TICKET) {
    return { ticket: process.env.VBK_TICKET.trim(), source: "process.env.VBK_TICKET" };
  }
  const envPath = path.join(ROOT, ".env");
  try {
    const text = await fs.readFile(envPath, "utf8");
    const match = text.match(/^VBK_TICKET\s*=\s*(.+)$/m);
    if (match) return { ticket: match[1].trim(), source: envPath };
  } catch {
    // .env 不存在的时候不打印，保持安静
  }
  return { ticket: "", source: "" };
}

async function main() {
  const { ticket, source } = await readTicket();
  if (!ticket) {
    console.error("❌ 未找到 VBK_TICKET。三种来源都可以：");
    console.error("   1) 命令行：node scripts/inject-vbk-ticket.mjs <ticket>");
    console.error("   2) 环境变量：VBK_TICKET=... node scripts/inject-vbk-ticket.mjs");
    console.error("   3) .env 文件：在项目根 .env 中写入 VBK_TICKET=<ticket>");
    process.exit(1);
  }
  console.log(`✓ ticket 来源：${source}（长度 ${ticket.length}）`);

  await fs.mkdir(PROFILE_DIR, { recursive: true });

  console.log(`→ 启动持久化 Chromium：${PROFILE_DIR}`);
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: "chrome",
    headless: true,
    viewport: { width: 1440, height: 960 },
    args: ["--disable-blink-features=AutomationControlled"],
  });

  let exitCode = 0;
  try {
    console.log("→ 注入 vbkticket cookie 到 .ctrip.com");
    await context.addCookies([
      {
        name: "vbkticket",
        value: ticket,
        domain: ".ctrip.com",
        path: "/",
        httpOnly: true,
        secure: true,
        sameSite: "Lax",
      },
    ]);

    const page = context.pages()[0] ?? (await context.newPage());
    console.log(`→ 验证登录：${LIST_URL}`);
    await page.goto(LIST_URL, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle").catch(() => {});

    const url = page.url();
    if (/login|passport/i.test(url)) {
      console.error(`✗ 验证失败：被重定向到登录页 ${url}`);
      console.error("   ticket 可能已过期或被服务端作废。");
      exitCode = 2;
    } else {
      const productListVisible = await page
        .getByText("产品列表", { exact: true })
        .first()
        .isVisible()
        .catch(() => false);
      if (!productListVisible) {
        console.error(`✗ 验证失败：当前 URL ${url}，但页面上找不到「产品列表」文本。`);
        console.error("   ticket 可能已过期或被服务端作废。");
        exitCode = 2;
      } else {
        console.log(`✓ 验证通过：${url}`);
      }
    }
  } catch (err) {
    console.error("✗ 注入过程异常：", err && err.message ? err.message : err);
    exitCode = 1;
  } finally {
    // 关掉走 Chromium 自己的 cookies 落盘；不能用 Browser.close()，
    // 否则 persistent context 的 SQLite 写入时机会被绕过。
    await context.close().catch(() => {});
  }

  if (exitCode === 0) {
    console.log("✓ 已登录状态已写入 .data/chrome-profile/Default/Cookies。");
    console.log("   下次 launchVbkBrowser / Electron 嵌入浏览器都会带上这条 cookie。");
  }
  process.exit(exitCode);
}

main().catch((err) => {
  console.error("✗ 脚本启动失败：", err && err.message ? err.message : err);
  process.exit(1);
});
