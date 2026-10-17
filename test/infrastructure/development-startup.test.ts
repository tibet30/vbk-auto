import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  SAFE_DEVELOPMENT_STARTUP_ENV,
  isSafeDevelopmentStartup,
} from "../../src/main/development-startup.js";

const mainSource = readFileSync(new URL("../../src/main/main.ts", import.meta.url), "utf8");
const windowSource = readFileSync(new URL("../../src/main/create-window.ts", import.meta.url), "utf8");
const browserSource = readFileSync(new URL("../../src/main/infrastructure/vbk-browser.ts", import.meta.url), "utf8");
const productStorageSource = readFileSync(new URL("../../src/main/application/product-storage.ts", import.meta.url), "utf8");
const diagnosticSource = readFileSync(new URL("../../src/main/infrastructure/product-diagnostic-reporter.ts", import.meta.url), "utf8");
const agentSetupSource = readFileSync(new URL("../../src/main/agent/integration-setup.ts", import.meta.url), "utf8");
const localRecoveryStart = mainSource.indexOf("if (!safeDevelopmentStartup) {\n    db.recoverUnansweredMessages()");
const localRecovery = mainSource.slice(localRecoveryStart, mainSource.indexOf("\n\n  const context:", localRecoveryStart));
const deferredRecoveryStart = mainSource.indexOf("if (!safeDevelopmentStartup) {\n    updateService.scheduleStartupCheck()");
const deferredRecovery = mainSource.slice(deferredRecoveryStart, mainSource.indexOf("\n  app.on(\"activate\"", deferredRecoveryStart));

test("安全启动只能由显式开发环境变量开启，打包态始终拒绝", () => {
  assert.equal(isSafeDevelopmentStartup(true, { [SAFE_DEVELOPMENT_STARTUP_ENV]: "1" }), true);
  assert.equal(isSafeDevelopmentStartup(true, { [SAFE_DEVELOPMENT_STARTUP_ENV]: "true" }), false);
  assert.equal(isSafeDevelopmentStartup(true, {}), false);
  assert.equal(isSafeDevelopmentStartup(false, { [SAFE_DEVELOPMENT_STARTUP_ENV]: "1" }), false);
});

test("安全启动隔离启动期同步、VBK 页面初始化和工作流恢复", () => {
  assert.match(mainSource, /isSafeDevelopmentStartup\(isDev\)/);
  assert.match(mainSource, /if \(!safeDevelopmentStartup\) cleanStaleChromiumProfileDb/);
  assert.match(mainSource, /if \(!safeDevelopmentStartup\) \{\s*syncCopyRules\(\)/);
  assert.match(mainSource, /if \(safeDevelopmentStartup && source === "status"\) return/);
  assert.equal((mainSource.match(/safeDevelopmentStartup \? \(\) => \{\} : vbkBindings\.noteVbkAccountActive/g) ?? []).length, 2);
  assert.match(mainSource, /safeDevelopmentStartup \? undefined : scheduleMemoryMaintenance/);
  assert.match(mainSource, /enableBackgroundSync: !safeDevelopmentStartup/);
  assert.match(mainSource, /externalAgentActionsEnabled: !safeDevelopmentStartup/);
  assert.match(agentSetupSource, /externalAgentActionsEnabled: context\.externalAgentActionsEnabled/);
  assert.match(agentSetupSource, /safeStartupLocalPreparationReady: \(localProductId\) => readiness\(localProductId\)\.ready/);
  assert.match(localRecovery, /recoverOrphanAutomationRuns/);
  assert.match(localRecovery, /recoverOrphanWorkflowTasks/);
  assert.match(deferredRecovery, /recoverQueuedAgentWorkflowTasks/);
  assert.match(windowSource, /initialiseVbkBrowser\?: boolean/);
  assert.match(windowSource, /args\.initialiseVbkBrowser !== false/);
  assert.match(browserSource, /private readonly initialiseEnabled = true/);
  assert.match(browserSource, /if \(!this\.initialiseEnabled\)/);
  assert.match(productStorageSource, /const backgroundSyncEnabled = args\.enableBackgroundSync !== false/);
  assert.doesNotMatch(productStorageSource, /createTibetProductService|createLocalProductCloudSync|desktop-products/);
  assert.match(diagnosticSource, /if \(args\.autoFlush !== false\) void flush\(\)/);
});
