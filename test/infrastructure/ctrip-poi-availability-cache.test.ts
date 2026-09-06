import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getCtripSightAvailability } from "../../src/main/infrastructure/ctrip-sight-availability.js";
import { VbkDatabase } from "../../src/main/infrastructure/database/database.js";

test("成功核验的 POI 在重启后仍从本地缓存读取", async () => {
  const dataPath = fs.mkdtempSync(path.join(os.tmpdir(), "vbk-ctrip-poi-cache-"));
  const poiId = 99001001;
  try {
    const first = new VbkDatabase(dataPath);
    first.saveCachedCtripPoiAvailability({
      poiId,
      status: "available",
      openStatus: "",
      latelyOpenTime: null,
      verifiedAt: new Date().toISOString(),
    });
    const reopened = new VbkDatabase(dataPath);
    let fetchCalls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error("不应请求携程");
    }) as typeof fetch;
    try {
      assert.deepEqual(await getCtripSightAvailability(undefined, poiId, reopened), {
        status: "available", openStatus: "", latelyOpenTime: null,
      });
      assert.equal(fetchCalls, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    fs.rmSync(dataPath, { recursive: true, force: true });
  }
});
