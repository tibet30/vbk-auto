/**
 * Sends a renderer notification only when the current page is still stable.
 *
 * `WebFrameMain.send` catches its own native failures and writes to stderr, so
 * callers cannot recover from a stale-frame send with an outer try/catch. A
 * durable notification may be dropped while the main frame is loading: the
 * renderer reads the saved state after reload.
 */
export interface RendererFrameTarget {
  isDestroyed(): boolean;
  readonly detached: boolean;
  send(channel: string, ...args: unknown[]): void;
}

export interface RendererContentsTarget {
  isDestroyed(): boolean;
  isLoadingMainFrame(): boolean;
  readonly mainFrame: RendererFrameTarget;
}

export interface RendererWindowTarget {
  isDestroyed(): boolean;
  readonly webContents: RendererContentsTarget;
}

/** Returns false when there is no stable renderer frame to receive the event. */
export function safeRendererSend(
  window: RendererWindowTarget | undefined,
  channel: string,
  ...args: unknown[]
): boolean {
  try {
    if (!window || window.isDestroyed()) return false;
    const contents = window.webContents;
    if (contents.isDestroyed() || contents.isLoadingMainFrame()) return false;
    const frame = contents.mainFrame;
    if (frame.isDestroyed() || frame.detached) return false;

    // Electron uses structured clone too, but WebFrameMain.send logs internally
    // rather than throwing. Validate first so ordinary bad payloads stay visible
    // to their caller instead of becoming an opaque renderer warning.
    structuredClone(args);
    frame.send(channel, ...args);
    return true;
  } catch (error) {
    if (isRendererLifecycleError(error)) return false;
    throw error;
  }
}

function isRendererLifecycleError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /render frame was disposed|webframemain.*(?:disposed|destroyed)|object has been destroyed|web contents.*(?:destroyed|disposed)/i.test(message);
}
