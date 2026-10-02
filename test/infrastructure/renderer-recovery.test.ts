import assert from "node:assert/strict";
import test from "node:test";
import { rendererRecoveryDelay, shouldRecoverRenderer } from "../../src/main/renderer-recovery.js";

test("renderer 崩溃仅恢复一次，并只接受 crash 或 OOM", () => {
  assert.equal(shouldRecoverRenderer("crashed", 0), true);
  assert.equal(shouldRecoverRenderer("oom", 0), true);
  assert.equal(shouldRecoverRenderer("killed", 0), false);
  assert.equal(shouldRecoverRenderer("crashed", 1), false);
  assert.equal(rendererRecoveryDelay(1), 500);
});
