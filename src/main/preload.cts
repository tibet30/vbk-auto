/**
 * Electron preload（CommonJS）：通过 contextBridge 把 ipcRenderer.invoke 包装成 window.vbk，
 * 避免 renderer 直接访问 ipcRenderer。
 *
 * 约定：
 *   - 命名空间按业务域（products / ai / research / browser / automation / debug /
 *     accounts / settings / contacts / cover / events / operationLog / planning）分组；
 *   - 每个方法都是一段一行 ipcRenderer.invoke，args 顺序与主进程 handle 保持一致；
 *   - events 的订阅均返回取消订阅函数，避免 renderer 误重复注册；
 *   - 不同 IPC 边界异常穿透：主进程负责 try/catch 与本地化文案，preload 不做额外包装。
 *
 * 封面（cover）命名空间要点：
 *   - uploadManual：renderer → main 把 base64 字节落本地副本，返回 meta；
 *   - read：renderer → main 拿到「data URL 形态的预览」(data:${mime};base64,...)，
 *           旧实现返回 file:// URL 在沙盒下偶发破图，新版统一走 data URL；
 *           返回字段名仍为 url 以兼容 renderer 调用；
 *   - listManual：列出现存手动上传 meta（仅元数据）；
 *   - exists：判定 fileId 本地副本是否还在（仅在 UI 想要给出"已失效"前置文案时调用）；
 *   - searchCtripLibrary：携程图库查询（仅 keyword），返回 image candidates；
 *           走 suggestPoi → searchImage → getImageInfo 直接 BrowserView fetch
 *           链路，不依赖「从图库资源导入」弹窗 / importpic-modal。
 */

import { contextBridge, ipcRenderer } from "electron";
import type { VbkApi } from "../shared/contracts.js";

const api: VbkApi = {
  appAuth: {
    status: () => ipcRenderer.invoke("appAuth:status"),
    listAccounts: () => ipcRenderer.invoke("appAuth:listAccounts"),
    captcha: () => ipcRenderer.invoke("appAuth:captcha"),
    login: (input) => ipcRenderer.invoke("appAuth:login", input),
    switchAccount: (userId) => ipcRenderer.invoke("appAuth:switchAccount", userId),
    startLogin: () => ipcRenderer.invoke("appAuth:startLogin"),
    logout: () => ipcRenderer.invoke("appAuth:logout"),
  },
  products: { list: () => ipcRenderer.invoke("products:list"), create: (input) => ipcRenderer.invoke("products:create", input), get: (id) => ipcRenderer.invoke("products:get", id), delete: (id) => ipcRenderer.invoke("products:delete", id), readiness: (id) => ipcRenderer.invoke("products:readiness", id), updateReviewField: (id, input) => ipcRenderer.invoke("products:updateReviewField", id, input), updateProductJson: (id, json) => ipcRenderer.invoke("products:updateProductJson", id, json) },
  ai: {
    send: (localProductId, content) => ipcRenderer.invoke("ai:send", localProductId, content),
    regenerate: (localProductId, field) => ipcRenderer.invoke("ai:regenerate", localProductId, field),
  },
  research: {
    accept: (localProductId, taskId, evidenceId) => ipcRenderer.invoke("research:accept", localProductId, taskId, evidenceId),
    refreshIssues: (localProductId) => ipcRenderer.invoke("research:refreshIssues", localProductId),
    resolveVehicleResource: (localProductId, taskId) => ipcRenderer.invoke("research:vehicleResource", localProductId, taskId),
    resolveHotelResource: (localProductId, taskId) => ipcRenderer.invoke("research:hotelResource", localProductId, taskId),
  },
  browser: {
    login: () => ipcRenderer.invoke("browser:login"),
    logout: () => ipcRenderer.invoke("browser:logout"),
    status: (refresh?: boolean) => ipcRenderer.invoke("browser:status", refresh),
    navigate: (url) => ipcRenderer.invoke("browser:navigate", url),
    currentUrl: () => ipcRenderer.invoke("browser:currentUrl"),
    openExternal: () => ipcRenderer.invoke("browser:openExternal"),
    setBounds: (bounds) => ipcRenderer.invoke("browser:setBounds", bounds),
    setVisible: (visible) => ipcRenderer.invoke("browser:setVisible", visible),
    listLoginAccounts: () => ipcRenderer.invoke("browser:listLoginAccounts"),
    addLogin: () => ipcRenderer.invoke("browser:addLogin"),
    switchAccount: (accountKey) => ipcRenderer.invoke("browser:switchAccount", accountKey),
    forgetAccount: (accountKey) => ipcRenderer.invoke("browser:forgetAccount", accountKey),
    suggestPoi: (keyword: string) => ipcRenderer.invoke("poi:suggest", keyword),
    suggestPoiDetail: (keyword, context) => ipcRenderer.invoke("poi:suggestDetail", keyword, context),
    suggestPoiDemo: (keyword: string) => ipcRenderer.invoke("poi:suggestDemo", keyword),
  },
  automation: {
    start: (localProductId) => ipcRenderer.invoke("automation:start", localProductId),
    retry: (localProductId) => ipcRenderer.invoke("automation:retry", localProductId),
    retryPhase: (localProductId, phase) => ipcRenderer.invoke("automation:retryPhase", localProductId, phase),
    retryOnePhase: (localProductId, phase) => ipcRenderer.invoke("automation:retryOnePhase", localProductId, phase),
    stop: (localProductId) => ipcRenderer.invoke("automation:stop", localProductId),
  },
  debug: {
    runStep: (stepName: string, argsJson: string) => ipcRenderer.invoke("automation:debug:runStep", stepName, argsJson),
    snapshot: (label?: string) => ipcRenderer.invoke("automation:debug:snapshot", label),
    hitBreakpoints: () => ipcRenderer.invoke("automation:debug:hitBreakpoints"),
    resume: (command: "continue" | "step" | "stop") => ipcRenderer.invoke("automation:debug:resume", command),
    listBreakpoints: () => ipcRenderer.invoke("automation:debug:listBreakpoints"),
  },
  accounts: {
    getFixedInfo: (accountName) => ipcRenderer.invoke("accounts:getFixedInfo", accountName),
    saveFixedInfo: (accountName, values) => ipcRenderer.invoke("accounts:saveFixedInfo", accountName, values),
    fixedInfoSchema: () => ipcRenderer.invoke("accounts:fixedInfoSchema"),
    /** 从当前已登录的 VBK 页面自动抓取 providerId，抓不到返回 null。 */
    detectProviderId: () => ipcRenderer.invoke("accounts:detectProviderId"),
    currentProviderId: () => ipcRenderer.invoke("accounts:currentProviderId"),
    listKnownAccounts: () => ipcRenderer.invoke("accounts:listKnownAccounts"),
    providerIdFor: (accountName) => ipcRenderer.invoke("accounts:providerIdFor", accountName),
  },
  settings: { get: () => ipcRenderer.invoke("settings:get"), listModels: (input) => ipcRenderer.invoke("settings:listModels", input), save: (input) => ipcRenderer.invoke("settings:save", input), test: (input) => ipcRenderer.invoke("settings:test", input) },
  contacts: { listProviderContactCards: (providerId, searchKeyword) => ipcRenderer.invoke("contacts:listProviderContactCards", providerId, searchKeyword), suggestPoi: (keyword) => ipcRenderer.invoke("contacts:suggestPoi", keyword) },
  cover: {
    uploadManual: (args) => ipcRenderer.invoke("cover:uploadManual", args),
    read: (args) => ipcRenderer.invoke("cover:read", args),
    listManual: () => ipcRenderer.invoke("cover:listManualCovers"),
    exists: (args) => ipcRenderer.invoke("cover:exists", args),
    /**
     * 阶段 A：按景点名称查 suggestpoi.json → 地址 / 景点候选列表；
     * UI 在地址列表里选中一个 place 后再调 searchCtripLibraryImages 走阶段 B。
     */
    searchCtripLibraryPlaces: (args) => ipcRenderer.invoke("cover:searchCtripLibraryPlaces", args),
    /**
     * 阶段 B：按已选 place 取该地址下的携程图库图片列表；
     * 链路：searchImage → getImageInfo（BrowserView 内联 fetch）。
     */
    searchCtripLibraryImages: (args) => ipcRenderer.invoke("cover:searchCtripLibraryImages", args),
  },
  events: {
    onProductUpdated(listener) { const handler = (_event: Electron.IpcRendererEvent, product: unknown) => listener(product as never); ipcRenderer.on("product:updated", handler); return () => ipcRenderer.removeListener("product:updated", handler); },
    onPlanningStateUpdated(listener) { const handler = (_event: Electron.IpcRendererEvent, localProductId: unknown, state: unknown) => listener(localProductId as string, state as never); ipcRenderer.on("planning:updated", handler); return () => ipcRenderer.removeListener("planning:updated", handler); },
    onPageReady(listener) { const handler = () => listener(); ipcRenderer.on("vbk:page-ready", handler); return () => ipcRenderer.removeListener("vbk:page-ready", handler); },
  },
  operationLog: { load: (query) => ipcRenderer.invoke("operationLog:load", query) },
  planning: {
    start: (localProductId) => ipcRenderer.invoke("planning:start", localProductId),
    resume: (localProductId) => ipcRenderer.invoke("planning:resume", localProductId),
    state: (localProductId) => ipcRenderer.invoke("planning:state", localProductId),
    rerunMajorStage: (localProductId, stage) => ipcRenderer.invoke("planning:rerunMajorStage", localProductId, stage),
  },
};
contextBridge.exposeInMainWorld("vbk", api);
