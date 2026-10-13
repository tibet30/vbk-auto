import { randomUUID } from "node:crypto";
import type { MainIpcContext } from "./context.js";
import { secureIpcMain as ipcMain, assertTrustedSender } from "../infrastructure/ipc-sender.js";
import { HotelDraftRetry } from "../operations/hotel-draft-retry.js";
import { applyVerifiedHotelDraftState } from "../operations/hotel-draft-state.js";
import { restoreHotelResourceCheckpoint } from "../operations/restore-hotel-resource.js";
import { getVbkRequestPage } from "../infrastructure/vbk-request-page.js";
import { verifyPlatformHotelDraftRulesReadback } from "../automation/ctrip/hotel-rule-api.js";

/** Prepare an exact lodging-rule scope; only fresh user confirmation permits draft writes. */
export function registerHotelDraftRetryIpc(context: MainIpcContext) {
  const accountKey = () => context.db.getSetting("vbkActiveAccountKey")?.value?.trim() ?? "";
  const broadcast = (id: string) => {
    const product = context.db.getProduct(id);
    if (product) context.broadcastProduct(product);
    const snapshot = context.db.getAgentSnapshot(id);
    if (snapshot) context.emitAgentSnapshot?.(snapshot);
  };
  const retry = new HotelDraftRetry({
    getProduct: id => context.db.getProduct(id), accountKey,
    assertIdle: id => { context.productWorkflows.assertIdle(id, "resource"); context.productWorkflows.assertVbkPageIdle("住宿规则草稿"); },
    withLocks: (id, work) => context.productWorkflows.runExclusive(id, "resource", () => context.productWorkflows.runVbkPageExclusive(work)),
    getPage: () => getVbkRequestPage(context.browser),
    saveProduct: (id, product, expectedVersion) => context.productMutations.replace(id, product, { expectedVersion }),
    record: (id, status, message, payload) => context.db.appendOperationLog({ id: randomUUID(), localProductId: id,
      phase: "hotelResource", type: "automation", name: "住宿规则草稿保存", status, message, payload, startedAt: new Date().toISOString() }),
    message: (id, content) => {
      const snapshot = context.db.getAgentSnapshot(id);
      if (snapshot?.run) {
        snapshot.events.push({ id: randomUUID(), runId: snapshot.run.id, type: "status", createdAt: new Date().toISOString(), content });
        context.db.saveAgentSnapshot(snapshot);
      }
      broadcast(id);
    },
    complete: (id, proof, expectedVersion) => { applyVerifiedHotelDraftState(context.db, id, proof, expectedVersion); broadcast(id); },
  });
  ipcMain.handle("automation:prepareHotelDraftRetry", (event, id: string) => {
    assertTrustedSender(event, "automation:prepareHotelDraftRetry");
    context.productWorkflows.assertIdle(id, "resource");
    const plan = retry.prepare(id);
    restoreHotelResourceCheckpoint(context.db, id); broadcast(id);
    return plan;
  });
  ipcMain.handle("automation:saveHotelDraftRetry", (event, token: string) => {
    assertTrustedSender(event, "automation:saveHotelDraftRetry");
    return retry.execute(token);
  });
  ipcMain.handle("automation:refreshHotelDraftState", async (event, id: string) => {
    assertTrustedSender(event, "automation:refreshHotelDraftState");
    context.productWorkflows.assertIdle(id, "resource");
    return context.productWorkflows.runExclusive(id, "resource", () => context.productWorkflows.runVbkPageExclusive(async () => {
      const current = context.db.getProduct(id);
      if (!current?.productId || current.vbkAccount !== accountKey()) throw new Error("请切换至产品所属 VBK 账号");
      const proof = await verifyPlatformHotelDraftRulesReadback(await getVbkRequestPage(context.browser), current.product, current.productId);
      const product = applyVerifiedHotelDraftState(context.db, id, proof, current.productJsonVersion ?? 0);
      broadcast(id);
      return { product, readiness: context.readiness(id) };
    }));
  });
}
