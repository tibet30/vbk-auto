/**
 * VBK 只读端口的真实装配：把现有浏览器适配器与独占页面执行设施接成 Skill 可用的端口。
 *
 * 这里只做"读"：状态查询读会话/缓存，联系人查询走已登录页面发起一次只读请求。
 * 任何写动作都不在这条链路上，写入必须走动作计划 → 授权 → 收据。
 */

import { listProviderContactCards } from "../infrastructure/butler-contacts.js";
import { suggestPoiDetail } from "../infrastructure/poi-suggest/derive.js";
import { detectProviderIdFromBrowser } from "../infrastructure/provider-id-source.js";
import { getVbkRequestPage } from "../infrastructure/vbk-request-page.js";
import type { MainIpcContext } from "../ipc/context.js";
import { buildVbkReadPort } from "./ports.js";
import type { VbkReadPort } from "../agent-runtime/index.js";

export function buildVbkReadPortFromContext(context: MainIpcContext): VbkReadPort {
  return buildVbkReadPort({
    db: context.db,
    searchPoi: (keyword: string) =>
      context.productWorkflows.runVbkPageExclusive(() => suggestPoiDetail(context.browser, keyword)),
    /**
     * 缓存里没有 providerId 时，用当前已登录会话现场探测一次（只读），
     * 探测到就顺手写回缓存；探测不到才让调用方失败。
     */
    detectProviderId: () => context.productWorkflows.runVbkPageExclusive(async () => {
      const page = await getVbkRequestPage(context.browser);
      return detectProviderIdFromBrowser(page);
    }),
    rememberProviderId: (accountKey: string, providerId: number) => {
      context.db.setProviderIdFor(accountKey, providerId);
    },
    browser: {
      listKnownLoginAccounts: () => context.browser.listKnownLoginAccounts(),
      status: (refresh?: boolean) => context.browser.status(refresh === true),
      listProviderContactCards: (providerId: number, keyword?: string) =>
        context.productWorkflows.runVbkPageExclusive(async () => {
          const page = await getVbkRequestPage(context.browser);
          return listProviderContactCards(page, providerId, keyword);
        }),
    },
  });
}
