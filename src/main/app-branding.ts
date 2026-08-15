import fs from "node:fs";
import path from "node:path";
import { app, Menu, nativeImage } from "electron";
import { APP_NAME } from "../shared/brand.js";

/**
 * 尽早覆盖 Electron 默认应用元信息，避免 macOS 菜单栏仍显示默认值。
 */
export function applyAppMetadata(): void {
  app.setName(APP_NAME);
  app.setAboutPanelOptions({ applicationName: APP_NAME });
}

/**
 * 开发态显式覆盖 Dock 图标；打包态由安装包元信息负责。
 */
export function applyDevDockIcon(root: string): void {
  if (!app.isPackaged && process.platform === "darwin") {
    const iconPath = path.join(root, "src", "renderer", "assets", "brand", "logo.png");
    if (!fs.existsSync(iconPath)) return;
    const icon = nativeImage.createFromPath(iconPath);
    if (!icon.isEmpty() && app.dock) app.dock.setIcon(icon);
  }
}

/**
 * 显式安装应用菜单，避免开发态回退到 Electron 默认菜单名。
 * 依据 Electron 官方菜单文档，macOS 顶部第一项由应用菜单提供。
 */
export function installApplicationMenu(): void {
  if (process.platform !== "darwin") return;
  const menu = Menu.buildFromTemplate([
    {
      label: APP_NAME,
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    { role: "fileMenu" },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ]);
  Menu.setApplicationMenu(menu);
}
