/** Existing installs default to on; only an explicit saved "false" disables notifications. */
export function resolveSystemNotificationsEnabled(savedValue?: string): boolean {
  return savedValue !== "false";
}
