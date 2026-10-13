import { useLayoutEffect } from "react";
import { api } from "./constants";

// 待显示与已显示的弹窗共用一个遮挡状态，避免多个弹窗相互提前恢复原生视图。
const pendingDialogs = new Set<symbol>();
let requestedOverlay: boolean | undefined;
let visibilityRequest = Promise.resolve();

function syncVisibility(): Promise<void> {
  const open = pendingDialogs.size > 0 || Boolean(document.querySelector("dialog:modal"));
  const bridge = api();
  if (!bridge) return Promise.resolve();
  if (requestedOverlay === open) return visibilityRequest;
  requestedOverlay = open;
  const request = bridge.browser.setOverlayOpen(open);
  visibilityRequest = request;
  void request.catch(() => {
    if (visibilityRequest === request) requestedOverlay = undefined;
  });
  return request;
}

/** 先隐藏原生视图，再进入页面顶层；过期的打开请求不得重新弹出。 */
export async function showModalAboveVbk(dialog: HTMLDialogElement, canOpen = () => true): Promise<void> {
  const request = Symbol();
  pendingDialogs.add(request);
  try {
    await syncVisibility();
    if (canOpen() && dialog.isConnected && !dialog.open) dialog.showModal();
  } finally {
    pendingDialogs.delete(request);
    await syncVisibility();
  }
}

export function closeModalAboveVbk(dialog: HTMLDialogElement): void {
  if (dialog.open) dialog.close();
  void syncVisibility().catch(() => {});
}

/** 覆盖 Esc、原生 close、动态移除和其它页面弹窗，只有最后一个关闭才恢复。 */
export function useVbkModalVisibility(): void {
  useLayoutEffect(() => {
    const sync = () => { void syncVisibility().catch(() => {}); };
    const observer = new MutationObserver(sync);
    observer.observe(document.body, { subtree: true, childList: true, attributeFilter: ["open"] });
    sync();
    return () => {
      observer.disconnect();
      pendingDialogs.clear();
      requestedOverlay = undefined;
      visibilityRequest = api()?.browser.setOverlayOpen(false) ?? Promise.resolve();
      void visibilityRequest.catch(() => {});
    };
  }, []);
}
