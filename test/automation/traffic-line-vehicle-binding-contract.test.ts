import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = [
  readFileSync(new URL("../../src/main/automation/ctrip/traffic-line/main.ts", import.meta.url), "utf8"),
  readFileSync(new URL("../../src/main/automation/ctrip/traffic-line/segments.ts", import.meta.url), "utf8"),
  readFileSync(new URL("../../src/main/automation/ctrip/traffic-line/segments/submit.ts", import.meta.url), "utf8"),
  readFileSync(new URL("../../src/main/automation/ctrip/traffic-line/main/process-target.ts", import.meta.url), "utf8"),
  readFileSync(new URL("../../src/main/automation/ctrip/traffic-line/presentation.ts", import.meta.url), "utf8"),
].join("\n");
const readbackSource = [
  readFileSync(new URL("../../src/main/automation/ctrip/traffic-line/readback.ts", import.meta.url), "utf8"),
].join("\n");

test("全部交通与用车资源提交后再写回行程，避免正式交通节点被回滚", () => {
  // After split, ensureTrafficLineSegments is invoked inside a submit callback
  // (no leading `await`). Use plain call signature.
  const submitted = source.indexOf("ensureTrafficLineSegments(");
  const binding = source.indexOf("await ensureTrafficLineVehicleBinding(page, relationship.productId, options.product);", submitted);
  const itinerary = source.indexOf("await ensureTrafficLineItinerary(page, relationship.productId, target.variant, endpoints);", binding);
  const checkpoint = source.indexOf('checkpoint("resourcesSaved", relationship.productId);', binding);

  assert.ok(submitted >= 0, "必须先提交交通资源段");
  assert.ok(itinerary > submitted, "交通资源提交后必须写回交通行程");
  assert.ok(itinerary > binding, "用车正式提交后必须重新保存交通行程");
  assert.ok(checkpoint > binding, "正式段回读成功前不得记录 resourcesSaved");
  assert.match(readFileSync(new URL("../../src/main/automation/ctrip/vehicle-resource-api/vehicle-binding.ts", import.meta.url), "utf8"), /ensureVehicleResourceBinding/);
});

test("已激活子产品直接进入最终回读，不重放其资源写入", () => {
  // After split, the active branch sits in main/process-target.ts. Slice from
  // the active check up to the next `return` (no `await ensureTrafficLinePresentation`
  // in this branch — that comes later in the function body).
  const activeStart = source.indexOf("if (relationship.active === true)");
  assert.ok(activeStart >= 0, "active branch must exist");
  // Find the closing of the early `return { pending: ... }` block.
  const pendingStart = source.indexOf("return { pending:", activeStart);
  assert.ok(pendingStart >= 0, "active branch must short-circuit with pending result");
  const pendingEnd = source.indexOf("};", pendingStart) + 2;
  const activeBranch = source.slice(activeStart, pendingEnd);
  assert.match(activeBranch, /return \{ pending:/);
  assert.doesNotMatch(activeBranch, /ensureTrafficLineSegments|ensureTrafficLineVehicleBinding/);
});

test("交通子产品最终行程修复必须沿用已解析端点", () => {
  assert.match(
    readbackSource,
    /ensureTrafficLineItinerary\(page,\s*childProductId,\s*variant,\s*endpoints\)/,
    "单子产品最终回读修复不能丢失机场/车站端点",
  );
  assert.match(
    readbackSource,
    /ensureTrafficLineItinerary\(page,\s*child\.childProductId,\s*child\.variant,\s*endpoints\)/,
    "整组稳定门修复不能丢失机场/车站端点",
  );
});
