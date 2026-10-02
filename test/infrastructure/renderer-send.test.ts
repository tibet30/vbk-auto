import assert from "node:assert/strict";
import test from "node:test";
import { safeRendererSend, type RendererWindowTarget } from "../../src/main/infrastructure/renderer-send.js";

function target(overrides: Partial<{
  windowDestroyed: boolean;
  contentsDestroyed: boolean;
  loading: boolean;
  frameDestroyed: boolean;
  detached: boolean;
  getFrame(): ReturnType<typeof frame>;
}> = {}): RendererWindowTarget {
  const currentFrame = overrides.getFrame?.() ?? frame({
    destroyed: overrides.frameDestroyed,
    detached: overrides.detached,
  });
  return {
    isDestroyed: () => Boolean(overrides.windowDestroyed),
    webContents: {
      isDestroyed: () => Boolean(overrides.contentsDestroyed),
      isLoadingMainFrame: () => Boolean(overrides.loading),
      get mainFrame() { return currentFrame; },
    },
  };
}

function frame(overrides: Partial<{ destroyed: boolean; detached: boolean; send(...args: unknown[]): void }> = {}) {
  return {
    isDestroyed: () => Boolean(overrides.destroyed),
    detached: Boolean(overrides.detached),
    send: overrides.send ?? (() => {}),
  };
}

test("safeRendererSend sends one complete notification through the live main frame", () => {
  const calls: unknown[][] = [];
  const sent = safeRendererSend(target({ getFrame: () => frame({
    send: (...args: unknown[]) => { calls.push(args); },
  }) }), "product:updated", { id: "p-1" });
  assert.equal(sent, true);
  assert.deepEqual(calls, [["product:updated", { id: "p-1" }]]);
});

test("safeRendererSend drops destroyed, loading, or detached renderer targets", () => {
  for (const overrides of [
    { windowDestroyed: true },
    { contentsDestroyed: true },
    { loading: true },
    { frameDestroyed: true },
    { detached: true },
  ]) {
    assert.equal(safeRendererSend(target(overrides), "product:updated", { id: "p-1" }), false);
  }
});

test("safeRendererSend absorbs a lifecycle getter race", () => {
  const raced = target();
  Object.defineProperty(raced.webContents, "mainFrame", {
    get() { throw new Error("Render frame was disposed before WebFrameMain could be accessed"); },
  });
  assert.equal(safeRendererSend(raced, "product:updated", { id: "p-1" }), false);
});

test("safeRendererSend reports an invalid payload before Electron can hide it", () => {
  const invalidPayload = target();
  assert.throws(
    () => safeRendererSend(invalidPayload, "product:updated", { value: () => undefined }),
    /could not be cloned/,
  );
});
