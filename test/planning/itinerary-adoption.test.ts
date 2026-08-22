import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  applyPoiMatches,
  collectRequiredItinerarySpots,
  hasPendingItineraryAdoption,
  itineraryFingerprint,
  guardLatestItineraryAdoption,
  isTravelNodeName,
  markItineraryPendingAdoption,
  markItineraryBlocked,
  markItineraryVerifying,
  markItineraryAccepted,
} from "../../src/main/planning/itinerary-adoption.js";
import { createPlanningPlanV2 } from "../../src/main/planning/three-stage-orchestrator.js";
import {
  assertAdoptionSignalPrerequisites,
  ITINERARY_ADOPTION_SYNC_ERROR,
  ItineraryAdoptionSyncError,
} from "../../src/main/planning/itinerary-adoption-signal.js";

const itinerary = [{
  day: 1,
  spots: [
    { name: "宽窄巷子", poiName: "宽窄巷子", poiId: 11 },
    { name: "成都机场接站" },
  ],
}];

test("itinerary patch only invalidates completion and persists a stable adoption signal", () => {
  const plan = createPlanningPlanV2("2026-08-22T00:00:00.000Z");
  plan.nodes = plan.nodes.map((node) => ({ ...node, status: "completed", attempts: 3, startedAt: "old", completedAt: "old", summary: "old", error: "old" }));
  const next = markItineraryPendingAdoption(plan, itinerary, "2026-08-22T01:00:00.000Z");
  assert.equal(next.status, "needs_user");
  assert.equal(next.itineraryAdoption?.status, "pending");
  assert.equal(next.itineraryAdoption?.itineraryRevision, itineraryFingerprint(itinerary));
  assert.equal(next.currentNode, "poiResolution");
  assert.equal(next.nodes.find((node) => node.id === "poiResolution")?.status, "invalidated");
  assert.equal(next.nodes.find((node) => node.id === "itineraryDraft")?.status, "invalidated");
  assert.equal(next.nodes.find((node) => node.id === "commercial")?.status, "invalidated");
  for (const id of ["poiResolution", "itineraryDraft", "copy", "presentation", "commercial", "cover", "vehicleResource", "finalValidation"]) {
    const node = next.nodes.find((item) => item.id === id);
    assert.equal(node?.attempts, 0, id);
    assert.equal(node?.startedAt, undefined, id);
    assert.equal(node?.completedAt, undefined, id);
    assert.equal(node?.error, undefined, id);
    assert.equal(node?.summary, undefined, id);
  }
  assert.equal(hasPendingItineraryAdoption(next), true);
});

test("POI verification updates current itinerary while keeping travel nodes out of the requirement", () => {
  const spots = collectRequiredItinerarySpots(itinerary);
  assert.deepEqual(spots.map((spot) => spot.travelNode), [false, true]);
  const result = applyPoiMatches(itinerary, new Map([["宽窄巷子", { poiName: "宽窄巷子景区", poiId: 99 }]]));
  assert.equal(result.missing.length, 0);
  assert.deepEqual((result.itinerary[0].spots as any[])[0], { name: "宽窄巷子景区", poiName: "宽窄巷子景区", poiId: 99 });
});

test("failed adoption remains recoverable and success starts completion from copy", () => {
  const plan = {
    ...createPlanningPlanV2(),
    nodes: createPlanningPlanV2().nodes.map((node) => ({ ...node, attempts: 3, startedAt: "old", completedAt: "old", summary: "old", error: "old" })),
  };
  const verifying = { ...plan, status: "running" as const };
  const blocked = markItineraryBlocked(verifying, itinerary, "第1天景点未匹配");
  assert.equal(blocked.status, "needs_user");
  assert.equal(blocked.itineraryAdoption?.status, "blocked");
  assert.match(blocked.itineraryAdoption?.error ?? "", /未匹配/);
  for (const id of ["poiResolution", "itineraryDraft", "copy", "presentation", "commercial", "cover", "vehicleResource", "finalValidation"]) {
    assert.equal(blocked.nodes.find((node) => node.id === id)?.attempts, 0, id);
  }
  const retrying = markItineraryVerifying(blocked, itinerary, "2026-08-22T02:00:00.000Z");
  assert.equal(retrying.nodes.find((node) => node.id === "poiResolution")?.status, "running");
  assert.equal(retrying.nodes.find((node) => node.id === "poiResolution")?.error, undefined);
  const accepted = markItineraryAccepted(retrying, itinerary, "2026-08-22T03:00:00.000Z");
  assert.equal(accepted.currentNode, "copy");
  assert.equal(accepted.itineraryAdoption?.status, "accepted");
  assert.equal(accepted.nodes.find((node) => node.id === "poiResolution")?.status, "completed");
  assert.equal(accepted.nodes.find((node) => node.id === "itineraryDraft")?.status, "completed");
  assert.equal(accepted.nodes.find((node) => node.id === "poiResolution")?.attempts, 1);
  assert.equal(accepted.nodes.find((node) => node.id === "itineraryDraft")?.attempts, 1);
  assert.equal(accepted.nodes.find((node) => node.id === "commercial")?.attempts, 0);
  assert.deepEqual(accepted.poiCandidates, [{ requestedName: "宽窄巷子", status: "selected", poiName: "宽窄巷子", poiId: 11 }]);
});

test("settlement nodes do not require POI, while real scenic town names remain POIs", () => {
  for (const name of ["康定城区", "雅安城区", "成都城区", "市区", "县城", "镇区", "四姑娘山镇", "新都桥镇", "机场接送", "当地住宿"]) {
    assert.equal(isTravelNodeName(name), true, name);
  }
  for (const name of ["乌镇", "乌镇景区", "古镇景点", "黄龙景区"]) {
    assert.equal(isTravelNodeName(name), false, name);
  }
});

test("latest adoption guard rejects a changed route or a changed verification state", () => {
  const plan = markItineraryVerifying(createPlanningPlanV2(), itinerary);
  assert.deepEqual(guardLatestItineraryAdoption(itinerary, plan, itinerary), { ok: true });
  assert.deepEqual(guardLatestItineraryAdoption([{ ...itinerary[0], day: 2 }], plan, itinerary), { ok: false, reason: "itinerary_changed" });
  const pending = markItineraryPendingAdoption(plan, itinerary);
  assert.deepEqual(guardLatestItineraryAdoption(itinerary, pending, itinerary), { ok: false, reason: "adoption_state_changed" });
});

test("adoption signal sync failure has an actionable error contract", () => {
  assert.match(ITINERARY_ADOPTION_SYNC_ERROR, /行程已生成/);
  assert.match(ITINERARY_ADOPTION_SYNC_ERROR, /待采用状态未同步/);
  assert.match(ITINERARY_ADOPTION_SYNC_ERROR, /重试本轮/);
});

test("adoption signal prerequisites reject missing local product, revision, or planning v2", () => {
  for (const input of [
    { hasLocalProduct: false, revision: 3, planningVersion: 2 },
    { hasLocalProduct: true, revision: undefined, planningVersion: 2 },
    { hasLocalProduct: true, revision: 3, planningVersion: undefined },
    { hasLocalProduct: true, revision: 3, planningVersion: 1 },
  ]) {
    assert.throws(() => assertAdoptionSignalPrerequisites(input), (error: unknown) => {
      return error instanceof ItineraryAdoptionSyncError
        && error.suppressFinalEmit
        && error.message === ITINERARY_ADOPTION_SYNC_ERROR;
    });
  }
});

test("sync failure cannot mirror an un-signaled itinerary", () => {
  const aiSource = readFileSync("src/main/ipc/product-ai-ipc.ts", "utf8");
  const signalSource = readFileSync("src/main/planning/itinerary-adoption-signal.ts", "utf8");
  assert.match(aiSource, /if \(!suppressFinalEmit\) emitProduct/);
  assert.match(signalSource, /restoreLocalFromRemote/);
  assert.match(signalSource, /new ItineraryAdoptionSyncError\(!restored\)/);
});
