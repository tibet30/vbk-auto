// @ts-nocheck
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { PROFILE_DIR, URLS } from "./constants.js";

export class AuthenticationRequiredError extends Error {
  constructor(message = "VBK 登录态不可用，请在 VBK Desktop 中重新登录") {
    super(message);
    this.name = "AuthenticationRequiredError";
  }
}

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

export async function waitForUser(message) {
  if (!process.stdin.isTTY || process.env.VBK_NO_PAUSE === "true") return;
  process.stdout.write(`${message}\n按 Enter 结束本次浏览器会话…`);
  process.stdin.resume();
  await new Promise((resolve) => process.stdin.once("data", resolve));
}
