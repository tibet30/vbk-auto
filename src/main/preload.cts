/**
 * Electron preload（CommonJS）：通过 contextBridge 把 ipcRenderer.invoke 包装成 window.vbk，
 * 避免 renderer 直接访问 ipcRenderer。
 *
 * 约定：
 *   - 命名空间按业务域（projects / ai / research / browser / automation / debug /
 *     accounts / settings / contacts / events / operationLog / planning）分组；
 *   - 每个方法都是一段一行 ipcRenderer.invoke，args 顺序与主进程 handle 保持一致；
 *   - events.onProjectUpdated 返回取消订阅函数，避免 renderer 误重复注册；
 *   - 不同 IPC 边界异常穿透：主进程负责 try/catch 与本地化文案，preload 不做额外包装。
 */

import { contextBridge, ipcRenderer } from "electron";
import type { VbkApi } from "../shared/contracts.js";

const api: VbkApi = {
  projects: { list: () => ipcRenderer.invoke("projects:list"), create: (input) => ipcRenderer.invoke("projects:create", input), get: (id) => ipcRenderer.invoke("projects:get", id), delete: (id) => ipcRenderer.invoke("projects:delete", id), readiness: (id) => ipcRenderer.invoke("projects:readiness", id), updateReviewField: (id, input) => ipcRenderer.invoke("projects:updateReviewField", id, input), updateProductJson: (id, json) => ipcRenderer.invoke("projects:updateProductJson", id, json) },
  ai: {
    send: (projectId, content) => ipcRenderer.invoke("ai:send", projectId, content),
    regenerate: (projectId, field) => ipcRenderer.invoke("ai:regenerate", projectId, field),
  },
  research: {
    accept: (projectId, taskId, evidenceId) => ipcRenderer.invoke("research:accept", projectId, taskId, evidenceId),
    resolveVehicleResource: (projectId, taskId) => ipcRenderer.invoke("research:vehicleResource", projectId, taskId),
    previewVehicleResourceByPrice: (projectId, dailyCost) => ipcRenderer.invoke("research:previewVehicleResourceByPrice", projectId, dailyCost),
    confirmVehicleResourcePreview: (projectId, previewId) => ipcRenderer.invoke("research:confirmVehicleResourcePreview", projectId, previewId),
    resolveHotelResource: (projectId, taskId) => ipcRenderer.invoke("research:hotelResource", projectId, taskId),
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
  },
  automation: {
    start: (projectId) => ipcRenderer.invoke("automation:start", projectId),
    retry: (projectId) => ipcRenderer.invoke("automation:retry", projectId),
    retryPhase: (projectId, phase) => ipcRenderer.invoke("automation:retryPhase", projectId, phase),
    retryOnePhase: (projectId, phase) => ipcRenderer.invoke("automation:retryOnePhase", projectId, phase),
    stop: (projectId) => ipcRenderer.invoke("automation:stop", projectId),
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
  settings: { get: () => ipcRenderer.invoke("settings:get"), getApiKey: (provider) => ipcRenderer.invoke("settings:getApiKey", provider), listModels: (input) => ipcRenderer.invoke("settings:listModels", input), save: (input) => ipcRenderer.invoke("settings:save", input), test: (input) => ipcRenderer.invoke("settings:test", input) },
  contacts: { listProviderContactCards: (providerId, searchKeyword) => ipcRenderer.invoke("contacts:listProviderContactCards", providerId, searchKeyword) },
  events: { onProjectUpdated(listener) { const handler = (_event: Electron.IpcRendererEvent, project: unknown) => listener(project as never); ipcRenderer.on("project:updated", handler); return () => ipcRenderer.removeListener("project:updated", handler); } },
  operationLog: { load: (query) => ipcRenderer.invoke("operationLog:load", query) },
  planning: {
    start: (projectId) => ipcRenderer.invoke("planning:start", projectId),
    resume: (projectId) => ipcRenderer.invoke("planning:resume", projectId),
    state: (projectId) => ipcRenderer.invoke("planning:state", projectId),
  },
};
contextBridge.exposeInMainWorld("vbk", api);
