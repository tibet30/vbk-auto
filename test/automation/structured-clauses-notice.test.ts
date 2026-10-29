import test from "node:test";
import assert from "node:assert/strict";
import {
  OPTIONAL_NOTICE_CLAUSE_IDS,
  saveStructuredProductClauses,
} from "../../src/main/automation/ctrip/clauses-api.js";
import { noPageClauseClient } from "./structured-clauses.test-helpers.js";

test("说明&须知页追加勾选红框须知条款，航班提前到达分钟数固定填 120", async () => {
  const { client, saved } = noPageClauseClient();
  await saveStructuredProductClauses(client, "79232466", {});
  const tab4 = saved.get(4) ?? [];
  assert.deepEqual([...OPTIONAL_NOTICE_CLAUSE_IDS].sort((a, b) => a - b),
    [371, 400, 439, 467, 473, 479, 485, 486, 491, 526, 538, 552, 1174, 41672]);
  for (const id of OPTIONAL_NOTICE_CLAUSE_IDS) assert.ok(tab4.some((item) => item.clauseItemId === id), `缺少 ${id}`);
  assert.equal(tab4.find((item) => item.clauseItemId === 491)?.elementDtos
    .find((element: any) => element.componentCode === "tripnoticeinput1")?.value, "120");
  for (const tab of [1, 2, 3]) {
    assert.ok(!(saved.get(tab) ?? []).some((item) => OPTIONAL_NOTICE_CLAUSE_IDS.includes(item.clauseItemId as never)));
  }
});

test("平台条款包缺少某条红框须知时静默跳过，不影响保存", async () => {
  const { client, saved } = noPageClauseClient(false, true, { omit: [400, 552] });
  const result = await saveStructuredProductClauses(client, "79232466", {});
  assert.equal(result.savedTabs.length, 4);
  const ids = (saved.get(4) ?? []).map((item) => item.clauseItemId);
  assert.ok(!ids.includes(400) && !ids.includes(552));
  assert.ok(ids.includes(491) && ids.includes(41672));
});

test("远端回读的航班提前到达分钟数不是 120 时条款阶段失败", async () => {
  const { client } = noPageClauseClient(false, true, { tamperMinutes: true });
  await assert.rejects(saveStructuredProductClauses(client, "79232466", {}), /分钟数不是 120/);
});

test("自由行同样勾选红框须知条款并填 120", async () => {
  const { client, saved } = noPageClauseClient();
  await saveStructuredProductClauses(client, "79232466", { productForm: "freeTravel" });
  const tab4 = saved.get(4) ?? [];
  for (const id of OPTIONAL_NOTICE_CLAUSE_IDS) assert.ok(tab4.some((item) => item.clauseItemId === id), `缺少 ${id}`);
  assert.equal(tab4.find((item) => item.clauseItemId === 491)?.elementDtos
    .find((element: any) => element.componentCode === "tripnoticeinput1")?.value, "120");
});
