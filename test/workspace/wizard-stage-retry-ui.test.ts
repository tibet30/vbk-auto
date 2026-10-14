import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL("../../src/renderer/app/actions/workflow/automation.ts", import.meta.url),
  "utf8",
);

test("产品信息和产品图文的重新执行发送受控向导重试指令", () => {
  assert.match(
    source,
    /import \{ formatWizardStageRetryInstruction \} from "\.\.\/\.\.\/\.\.\/\.\.\/shared\/wizard-stage-retry\.js";/,
  );
  assert.match(
    source,
    /const instruction = phaseName === "basic" \|\| phaseName === "presentation"\s*\? formatWizardStageRetryInstruction\(phaseName\)\s*:\s*`请检查并修复\$\{phaseDisplayLabel\(phaseName\)\}阶段，先展示修复后的方案并请求最终确认，再继续录入。`;/s,
  );
  assert.match(source, /await api\(\)!\.agent\.send\(product\.id, instruction\);/);
});

test("其它阶段仍保留原有重试分支", () => {
  assert.match(source, /phaseName === "hotelResource"[\s\S]*?prepareHotelDraftRetry/);
  assert.match(source, /phaseName === "trafficLine" && product\.status === "draft_saved"[\s\S]*?continueApproved/);
  assert.match(source, /phaseDisplayLabel\(phaseName\)/);
});
