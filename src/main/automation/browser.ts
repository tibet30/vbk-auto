// @ts-nocheck
/**
 * VBK 浏览器启动与登录态校验工具：
 *   - AuthenticationRequiredError：登录失败时统一抛的业务异常；
 *   - launchVbkBrowser：用持久化 profile 启动 Chromium，自动注入 VBK_TICKET cookie；
 *   - openAndVerifyList：先打开产品列表页，根据 URL / 页面文本判定是否已登录；
 *   - waitForUser：在 headful + TTY 调试时按 Enter 才放行。
 *
 * 头部带 `// @ts-nocheck`，page / context 类型在外部动态传入。
 */

import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { PROFILE_DIR, URLS } from "./constants.js";
import { APP_NAME } from "../../shared/brand.js";

export class AuthenticationRequiredError extends Error {
  constructor(message = `VBK 登录态不可用，请在 ${APP_NAME} 中重新登录`) {
    super(message);
    this.name = "AuthenticationRequiredError";
  }
}

/**
 * 启动一个持久化 Chromium 上下文（PROFILE_DIR）：
 *   - 1440×960 视口 + 禁用 blink 自动化标记；
 *   - 读到 VBK_TICKET 环境变量时自动写 .ctrip.com cookie；
 *   - 返回首个 page（或新开一个），以及 profilePath 给调用方清理/复用。
 */
export async function launchVbkBrowser({ headless = false } = {}) {
  const profilePath = path.resolve(PROFILE_DIR);
  await fs.mkdir(profilePath, { recursive: true });

  const context = await chromium.launchPersistentContext(profilePath, {
    channel: "chrome",
    headless,
    viewport: { width: 1440, height: 960 },
    args: ["--disable-blink-features=AutomationControlled"],
  });

  const ticket = process.env.VBK_TICKET?.trim();
  if (ticket) {
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
  }

  const page = context.pages()[0] ?? (await context.newPage());
  return { context, page, profilePath };
}

/**
 * 跳到产品列表 URL，等 networkidle；URL 含 login/passport 或页面没显示「产品列表」就
 * 抛 AuthenticationRequiredError，让上层走重新登录路径。
 */
export async function openAndVerifyList(page) {
  await page.goto(URLS.list, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle").catch(() => {});

  const url = page.url();
  const productListVisible = await page
    .getByText("产品列表", { exact: true })
    .first()
    .isVisible()
    .catch(() => false);

  if (/login|passport/i.test(url) || !productListVisible) {
    throw new AuthenticationRequiredError();
  }

  return page;
}

/**
 * 在 headful + TTY + VBK_NO_PAUSE 未设置时阻塞等待 Enter 键；用于人工复核场景。
 * CI / headless / 显式 VBK_NO_PAUSE 时直接 return 不阻塞。
 */
export async function waitForUser(message) {
  if (!process.stdin.isTTY || process.env.VBK_NO_PAUSE === "true") return;
  process.stdout.write(`${message}\n按 Enter 结束本次浏览器会话…`);
  process.stdin.resume();
  await new Promise((resolve) => process.stdin.once("data", resolve));
}