import test from "node:test";
import assert from "node:assert/strict";
import { TrafficLineItineraryReadbackError, recoverMissingTrafficItinerary } from "../../src/main/automation/ctrip/traffic-line/itinerary-materialization.js";

test("同一正式绑定版本的节点迟到可补保存一次，版本漂移和协议错误禁止写入", async () => {
  const id = "419208217395216471";
  const pending = new TrafficLineItineraryReadbackError(id, "子产品行程交通回读缺少首日或末日目标交通节点");
  let writes = 0;
  const repair = async () => { writes++; return { transportNodes: 2 }; };
  assert.deepEqual(await recoverMissingTrafficItinerary(pending, async () => id, repair), { transportNodes: 2 });
  assert.equal(writes, 1);
  for (const [error, current] of [[pending, "different-version"], [new Error("网络错误"), id], [new TrafficLineItineraryReadbackError(id, "当前绑定行程 ID 不同"), id]] as const) {
    await assert.rejects(() => recoverMissingTrafficItinerary(error, async () => current, repair));
  }
  assert.equal(writes, 1);
  await assert.rejects(() => recoverMissingTrafficItinerary(pending, async () => id, async () => { writes++; throw pending; }));
  assert.equal(writes, 2);
});
