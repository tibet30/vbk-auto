import type { Session } from "electron";
import { AsyncLocalStorage } from "node:async_hooks";
import type { Page } from "playwright";
import { attachVbkSessionFetch } from "./vbk-session-fetch-adapter.js";
import type { VbkSessionRequestBrowser } from "./vbk-session-request.js";

export type VbkRequestPage = Page & VbkSessionRequestBrowser & {
  acquireInteractivePage: () => Promise<Page>;
  withRequestSource: <T>(url: string, execute: () => Promise<T>) => Promise<T>;
};

/** The session is captured once; switching accounts invalidates this client. */
export function createVbkRequestPage(args: {
  session: Session;
  assertActive: () => void;
  interactivePage: () => Promise<Page>;
  currentUrl: () => string;
}): VbkRequestPage {
  const requestSource = new AsyncLocalStorage<string>();
  const acquireInteractivePage = async () => {
    args.assertActive();
    const page = await args.interactivePage();
    args.assertActive();
    return page;
  };
  const client = {
    nativeOnly: true,
    acquireInteractivePage,
    withRequestSource: <T>(url: string, execute: () => Promise<T>) => {
      if (new URL(url).origin !== "https://vbooking.ctrip.com") throw new Error("接口来源必须是 VBK 编辑入口");
      return requestSource.run(url, execute);
    },
    url: () => /^https?:\/\//.test(args.currentUrl()) ? args.currentUrl() : "https://vbooking.ctrip.com/",
    evaluate: async () => { throw new Error("接口录入客户端不提供页面执行上下文"); },
    goto: async (...params: Parameters<Page["goto"]>) => (await acquireInteractivePage()).goto(...params),
    reload: async (...params: Parameters<Page["reload"]>) => (await acquireInteractivePage()).reload(...params),
    waitForLoadState: async (...params: Parameters<Page["waitForLoadState"]>) =>
      (await acquireInteractivePage()).waitForLoadState(...params),
    screenshot: async (...params: Parameters<Page["screenshot"]>) =>
      (await acquireInteractivePage()).screenshot(...params),
  } as unknown as VbkRequestPage;
  attachVbkSessionFetch(client, args.session, args.assertActive);
  const post = client.vbkSessionFetch!;
  const get = client.vbkSessionGetText!;
  client.vbkSessionFetch = async request => {
    args.assertActive();
    const source = requestSource.getStore();
    return post({ ...request,
      referrer: request.referrer ?? source,
      referrerPolicy: request.referrerPolicy ?? (source ? "no-referrer-when-downgrade" : undefined),
    });
  };
  client.vbkSessionGetText = async request => { args.assertActive(); return get(request); };
  return client;
}

/** Compatibility for standalone Playwright runners and existing test doubles. */
export function getVbkRequestPage(browser: {
  requestPage?: () => Promise<Page>;
  page: () => Promise<Page>;
}): Promise<Page> {
  return browser.requestPage ? browser.requestPage() : browser.page();
}
