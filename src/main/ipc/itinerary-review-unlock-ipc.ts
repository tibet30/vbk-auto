import { randomUUID } from "node:crypto";
import type { MainIpcContext } from "./context.js";
import { secureIpcMain as ipcMain, assertTrustedSender } from "../infrastructure/ipc-sender.js";
import { getVbkRequestPage } from "../infrastructure/vbk-request-page.js";
import { ItineraryReviewUnlock } from "../operations/itinerary-review-unlock.js";
import { itineraryReviewRequestSource } from "../operations/itinerary-review-request-source.js";

/** A separate one-use confirmation; ordinary draft approval never submits an itinerary review. */
export function registerItineraryReviewUnlockIpc(context: MainIpcContext) {
  const unlock = new ItineraryReviewUnlock({
    getProduct: id => context.db.getProduct(id),
    accountKey: () => context.db.getSetting("vbkActiveAccountKey")?.value?.trim() ?? "",
    assertIdle: id => {
      context.productWorkflows.assertIdle(id, "resource");
      context.productWorkflows.assertVbkPageIdle("行程审核与标签解锁");
    },
    withLocks: (id, work) => context.productWorkflows.runExclusive(id, "resource",
      () => context.productWorkflows.runVbkPageExclusive(work)),
    getPage: async productId => itineraryReviewRequestSource(await getVbkRequestPage(context.browser), productId),
    stateStore: {
      get: id => context.db.getItineraryReviewUnlockState(id),
      save: state => context.db.saveItineraryReviewUnlockState(state),
    },
    record: (id, status, message, payload) => context.db.appendOperationLog({
      id: randomUUID(), localProductId: id, phase: "itineraryReviewUnlock",
      type: "automation", name: "行程审核与标签解锁", status, message, payload,
      startedAt: new Date().toISOString(),
    }),
  });
  ipcMain.handle("automation:getItineraryReviewUnlockState", (event, id: unknown) => {
    assertTrustedSender(event, "automation:getItineraryReviewUnlockState");
    return context.db.getItineraryReviewUnlockState(requireId(id)) ?? null;
  });
  ipcMain.handle("automation:prepareItineraryReviewUnlock", (event, id: unknown) => {
    assertTrustedSender(event, "automation:prepareItineraryReviewUnlock");
    return unlock.prepare(requireId(id));
  });
  ipcMain.handle("automation:executeItineraryReviewUnlock", (event, token: unknown) => {
    assertTrustedSender(event, "automation:executeItineraryReviewUnlock");
    return unlock.execute(requireId(token));
  });
  ipcMain.handle("automation:refreshItineraryReviewUnlock", (event, id: unknown) => {
    assertTrustedSender(event, "automation:refreshItineraryReviewUnlock");
    return unlock.refresh(requireId(id));
  });
}

function requireId(value: unknown): string {
  if (typeof value !== "string" || !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(value)) {
    throw new Error("产品或确认标识无效，请重新检查当前产品");
  }
  return value;
}
