import assert from "node:assert/strict";
import test from "node:test";
import { AgentHandoff } from "../../src/main/agent/core-handoff.js";

for (const outcome of ["complete", "pause"] as const) {
  test(`renderer polling retains handoff while ${outcome} waits for shared account readback`, async () => {
    let release!: (value: { accountKey: string; productVersion: string }) => void;
    const identity = new Promise<{ accountKey: string; productVersion: string }>(resolve => { release = resolve; });
    const handoff = new AgentHandoff({
      handoffApprovedWorkflow: () => true, accountFor: () => identity,
    } as any, {
      load: () => ({}), validApproval: () => undefined,
    } as any, async (_id, operation) => operation());
    assert.equal(handoff.tryStart("queued-product", { scope: ["vbk.write_phase:hotelResource"] } as any), true);
    const pending = outcome === "complete"
      ? handoff.complete("queued-product", "approval")
      : handoff.pause("queued-product", "approval", "VBK page busy");
    assert.equal(handoff.has("queued-product"), true);
    release({ accountKey: "vbk_fixture", productVersion: "unchanged" });
    await pending;
    assert.equal(handoff.has("queued-product"), false);
  });
}
