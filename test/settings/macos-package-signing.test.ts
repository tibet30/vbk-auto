import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("macOS 打包流程保留通知所需的完整签名 hook", () => {
  const config = fs.readFileSync("electron-builder.yml", "utf8");
  const hook = fs.readFileSync("scripts/after-pack-macos-sign.cjs", "utf8");

  assert.match(config, /afterPack:\s*scripts\/after-pack-macos-sign\.cjs/);
  assert.match(hook, /electronPlatformName\s*!==\s*"darwin"/);
  assert.match(hook, /"codesign"/);
  assert.match(hook, /"--deep"/);
  assert.match(hook, /"--sign",\s*"-"/);
});
