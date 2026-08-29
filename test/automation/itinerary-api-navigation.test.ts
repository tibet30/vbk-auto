import test from "node:test";
import assert from "node:assert/strict";

import { readFile } from "node:fs/promises";

test("行程 API 入口回读成功后不进行页面水合、导航或推进", async () => {
  const source = await readFile(
    new URL("../../src/main/automation/ctrip/itinerary/api-entry.ts", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("export async function fillItineraryDraftApi");
  const body = source.slice(start);
  assert.match(body, /ensureItineraryApi\(page,/);
  assert.doesNotMatch(body, /page\.goto|page\.reload|page\.evaluate|saveThenAdvance|提交审核并下一步/);
  assert.match(body, /savedWith: "itinerary-api"/);
  assert.doesNotMatch(body, /submitResult/);
});
