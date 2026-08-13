/** Pure URL policy for Electron renderer IPC senders. */

export interface RendererSenderTrustInput {
  url: string;
  isOwner: boolean;
  isMainFrame: boolean;
  isDev: boolean;
}

/**
 * Only the owner window's main frame may invoke business IPC handlers.
 * Development loads Vite from the exact URL configured in create-window.ts;
 * packaged builds load the bundled renderer over file:.
 */
export function isTrustedRendererSender(input: RendererSenderTrustInput): boolean {
  if (!input.isOwner || !input.isMainFrame) return false;

  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    return false;
  }

  if (input.isDev) {
    return url.protocol === "http:"
      && url.port === "5173"
      && url.hostname === "127.0.0.1";
  }

  return url.protocol === "file:";
}
