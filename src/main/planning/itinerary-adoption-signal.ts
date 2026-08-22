import type { MainIpcContext } from "../ipc/context.js";
import type { ProductDetail } from "../../shared/contracts.js";
import { logWarn } from "../../shared/log-timestamp.js";
import { markItineraryPendingAdoption } from "./itinerary-adoption.js";

export const ITINERARY_ADOPTION_SYNC_ERROR = "行程已生成，但待采用状态未同步，请重试本轮。";

export class ItineraryAdoptionSyncError extends Error {
  readonly suppressFinalEmit: boolean;
  constructor(suppressFinalEmit: boolean) {
    super(ITINERARY_ADOPTION_SYNC_ERROR);
    this.name = "ItineraryAdoptionSyncError";
    this.suppressFinalEmit = suppressFinalEmit;
  }
}

export function assertAdoptionSignalPrerequisites(input: {
  hasLocalProduct: boolean;
  revision?: number;
  planningVersion?: number;
}): void {
  if (!input.hasLocalProduct || !input.revision || input.planningVersion !== 2) {
    throw new ItineraryAdoptionSyncError(true);
  }
}

/** 把 itinerary patch 造成的“待采用”信号 revision-safe 地写入 Tibet。 */
export async function syncItineraryAdoptionSignal(context: MainIpcContext, localProductId: string): Promise<void> {
  const localSnapshot = context.db.getProduct(localProductId);
  let firstError: unknown;
  try {
    await syncOnce(context, localProductId, localSnapshot);
    return;
  } catch (error) {
    firstError = error;
  }
  try {
    await syncOnce(context, localProductId, localSnapshot);
    return;
  } catch (retryError) {
    logWarn("[AI] itinerary adoption signal retry failed", {
      localProductId,
      error: retryError instanceof Error ? retryError.message : String(retryError),
    });
  }
  const restored = await restoreLocalFromRemote(context, localProductId, localSnapshot);
  logWarn("[AI] itinerary adoption signal sync failed", {
    localProductId,
    error: firstError instanceof Error ? firstError.message : String(firstError),
    restored,
  });
  throw new ItineraryAdoptionSyncError(!restored);
}

async function syncOnce(context: MainIpcContext, localProductId: string, local: ProductDetail | undefined): Promise<void> {
  const remote = await context.remoteProducts.get(localProductId);
  assertAdoptionSignalPrerequisites({
    hasLocalProduct: Boolean(local),
    revision: remote.revision,
    planningVersion: remote.planning?.version,
  });
  const plan = markItineraryPendingAdoption(remote.planning!, local!.product.itinerary);
  const saved = await context.remoteProducts.update({
    ...remote,
    product: local!.product,
    researchTasks: local!.researchTasks,
    status: "planning",
    planning: plan,
    updatedAt: new Date().toISOString(),
  }, remote.revision!);
  context.db.importProductSnapshot(saved);
  context.broadcastProduct(saved);
}

async function restoreLocalFromRemote(context: MainIpcContext, localProductId: string, local: ProductDetail | undefined): Promise<boolean> {
  try {
    const latest = await context.remoteProducts.get(localProductId);
    const restored = local ? { ...latest, messages: local.messages } : latest;
    context.db.importProductSnapshot(restored);
    context.broadcastProduct(restored);
    return true;
  } catch (error) {
    logWarn("[AI] itinerary adoption local restore failed", {
      localProductId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}
