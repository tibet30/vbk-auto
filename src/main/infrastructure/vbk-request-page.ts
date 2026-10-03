import type { Session } from "electron";
import type { Page } from "playwright";
import { attachVbkSessionFetch } from "./vbk-session-fetch-adapter.js";
import type { VbkSessionRequestBrowser } from "./vbk-session-request.js";

export type VbkRequestPage = Page & VbkSessionRequestBrowser & {
  acquireInteractivePage: () => Promise<Page>;
};

/** The session is captured once; switching accounts invalidates this client. */
export function createVbkRequestPage(args: {
  session: Session;
  assertActive: () => void;
  interactivePage: () => Promise<Page>;
  currentUrl: () => string;
}): VbkRequestPage {
  const acquireInteractivePage = async () => {
    args.assertActive();
    const page = await args.interactivePage();
    args.assertActive();
    return page;
  };
  const client = {
    nativeOnly: true,
    acquireInteractivePage,
    url: () => args.currentUrl() || "https://vbooking.ctrip.com/",
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
  client.vbkSessionFetch = async request => { args.assertActive(); return post(request); };
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
