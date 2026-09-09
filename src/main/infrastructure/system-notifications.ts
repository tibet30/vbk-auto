import { app, BrowserWindow, Notification, shell } from "electron";
import type { SystemNotificationResult } from "../../shared/contracts.js";

export interface SystemNotificationInput {
  title: string;
  body: string;
  onClick?: () => void;
}

export function systemNotificationsSupported(): boolean {
  return app.isPackaged && process.platform === "darwin" && Notification.isSupported();
}

function focusApplicationWindow(): void {
  const window = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed());
  if (!window) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

/** Submit a native macOS notification and make clicking it return to the app. */
export function showSystemNotification(input: SystemNotificationInput): Promise<SystemNotificationResult> {
  if (!systemNotificationsSupported()) {
    return Promise.resolve({ shown: false, message: "当前系统不支持 macOS 系统通知。" });
  }

  return new Promise((resolve) => {
    const notification = new Notification({ title: input.title, body: input.body });
    notification.on("click", input.onClick ?? focusApplicationWindow);
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: SystemNotificationResult) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolve(result);
    };
    notification.once("show", () => finish({
      shown: true,
      message: "测试通知已由 macOS 接收，请查看通知中心。",
    }));
    notification.once("failed", (_event, error) => {
      const unsigned = /sign|bundle/i.test(error || "");
      finish({
        shown: false,
        message: unsigned
          ? "当前应用未完成代码签名，macOS 已拒绝通知；请使用正式安装包运行。"
          : error ? `macOS 拒绝通知：${error}` : "macOS 拒绝了系统通知，请检查通知设置。",
      });
    });
    timeout = setTimeout(() => finish({
      shown: false,
      message: "macOS 未返回通知投递结果，请检查应用签名与通知设置。",
    }), 5000);

    try {
      notification.show();
    } catch {
      finish({ shown: false, message: "系统通知发送失败，请检查应用签名与 macOS 通知设置。" });
    }
  });
}

export async function openSystemNotificationSettings(): Promise<void> {
  if (process.platform !== "darwin") return;
  await shell.openExternal("x-apple.systempreferences:com.apple.Notifications-Settings.extension");
}
