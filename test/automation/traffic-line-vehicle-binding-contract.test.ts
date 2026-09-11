import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL("../../src/main/automation/ctrip/traffic-line/main.ts", import.meta.url),
  "utf8",
);

test("交通资源提交后必须重新绑定用车组，再记录 resourcesSaved", () => {
  const submitted = source.indexOf("await ensureTrafficLineSegments(");
  const itinerary = source.indexOf("await ensureTrafficLineItinerary(page, relationship.productId, target.variant, endpoints);", submitted);
  const binding = source.indexOf("await ensureTrafficLineVehicleBinding(page, relationship.productId, options.product);", itinerary);
  const checkpoint = source.indexOf('checkpoint("resourcesSaved", relationship.productId);', binding);

  assert.ok(submitted >= 0, "必须先提交交通资源段");
  assert.ok(itinerary > submitted, "交通资源提交后必须写回交通行程");
  assert.ok(binding > itinerary, "交通行程写回后必须重新绑定用车组");
  assert.ok(checkpoint > binding, "正式段回读成功前不得记录 resourcesSaved");
  assert.match(source, /ensureVehicleResourceBinding\(page, productId, groupId, groupName, \{ submitDraft: true \}\)/);
});

test("已激活子产品直接进入最终回读，不重放其资源写入", () => {
  const activeBranch = source.slice(source.indexOf("if (relationship.active === true)"), source.indexOf("await ensureTrafficLinePresentation"));
  assert.match(activeBranch, /pending\.push/);
  assert.doesNotMatch(activeBranch, /ensureTrafficLineSegments|ensureTrafficLineVehicleBinding/);
});
