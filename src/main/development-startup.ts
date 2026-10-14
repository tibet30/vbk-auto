/**
 * Explicit opt-in for a development-only restart that must not contact
 * providers or resume work on its own. Packaged builds never enter this mode.
 */
export const SAFE_DEVELOPMENT_STARTUP_ENV = "VBK_SAFE_DEV_STARTUP";

export function isSafeDevelopmentStartup(
  development: boolean,
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  return development && environment[SAFE_DEVELOPMENT_STARTUP_ENV] === "1";
}
