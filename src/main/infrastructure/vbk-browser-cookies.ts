import type { WebContentsView } from "electron";
import type { SerialisedCookie } from "./vbk-cookie-serializer.js";
import {
  cookieUrl,
  normaliseExpiry,
  normaliseSameSite,
} from "./vbk-cookie-serializer.js";

export async function clearVbkViewStorage(view: WebContentsView): Promise<void> {
  await view.webContents.session.clearStorageData({
    storages: ["cookies", "localstorage", "indexdb", "serviceworkers", "cachestorage"],
  });
  await view.webContents.session.clearCache();
}

export async function collectVbkCookies(view?: WebContentsView): Promise<Electron.Cookie[]> {
  if (!view) return [];
  try {
    return await view.webContents.session.cookies.get({});
  } catch {
    return [];
  }
}

export async function setVbkCookieOn(view: WebContentsView, cookie: SerialisedCookie): Promise<void> {
  const url = cookieUrl(cookie);
  if (!url) return;
  const details: Electron.CookiesSetDetails = {
    url,
    name: cookie.name,
    value: cookie.value,
    path: cookie.path || "/",
    secure: Boolean(cookie.secure),
    httpOnly: Boolean(cookie.httpOnly),
    sameSite: normaliseSameSite(cookie.sameSite),
    expirationDate: normaliseExpiry(cookie.expires),
  };
  if (cookie.domain) details.domain = cookie.domain;
  try {
    await view.webContents.session.cookies.set(details);
  } catch {
    // 极少数 cookie（无效 domain / 跨 origin）写不进去，跳过。
  }
}
