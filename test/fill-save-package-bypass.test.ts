import {test, describe} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

describe("fillAndSavePackage performSubmit bypass", () => {
  test("includes performSubmit fallback when save button is disabled", () => {
    const src = readFileSync("src/main/automation/ctrip.ts", "utf8");
    // The bypass logic should look for formHolder.performSubmit
    assert.match(src, /formHolder\.performSubmit/, "should call performSubmit on formHolder");
    assert.match(src, /props\?\.form/, "should check formHolder has props.form");
    assert.match(src, /bypassed:\s*true/, "should mark result as bypassed");
  });

  test("keeps new required field fills (days, confirmHour)", () => {
    const src = readFileSync("src/main/automation/ctrip.ts", "utf8");
    assert.match(src, /NewPackage_days/, "should fill NewPackage_days");
    assert.match(src, /NewPackage_confirmHour/, "should fill NewPackage_confirmHour");
    assert.match(src, /NewPackage_vendorConfirmModeId/, "should fill NewPackage_vendorConfirmModeId");
  });

  test("uses form-based bestPane selector", () => {
    const src = readFileSync("src/main/automation/ctrip.ts", "utf8");
    // pickBestPane should filter by form.ant-form (not just NewPackage_* element count)
    assert.match(src, /filter\(\{\s*has:\s*page\.locator\("form\.ant-form"\)\s*\}\)/, "pickBestPane should filter by form.ant-form");
  });
});
