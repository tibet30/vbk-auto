const path = require("node:path");
const { execFileSync } = require("node:child_process");

/**
 * Electron's macOS notification API rejects unsigned apps. electron-builder skips
 * signing when this machine has no Developer ID identity, so keep local/test builds
 * functional with a complete ad-hoc signature. A configured Apple identity still
 * replaces this signature in electron-builder's normal signing phase.
 */
module.exports = async function afterPackMacosSign(context) {
  if (context.electronPlatformName !== "darwin") return;
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", appPath], { stdio: "inherit" });
};
