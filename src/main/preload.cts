import { contextBridge, ipcRenderer } from "electron";
import type { VbkApi } from "../shared/contracts.js";

const api: VbkApi = {
  projects: { list: () => ipcRenderer.invoke("projects:list"), create: (input) => ipcRenderer.invoke("projects:create", input), get: (id) => ipcRenderer.invoke("projects:get", id), readiness: (id) => ipcRenderer.invoke("projects:readiness", id) },
  ai: { send: (projectId, content) => ipcRenderer.invoke("ai:send", projectId, content) },
  research: { accept: (projectId, taskId, evidenceId) => ipcRenderer.invoke("research:accept", projectId, taskId, evidenceId) },
  browser: { login: () => ipcRenderer.invoke("browser:login"), logout: () => ipcRenderer.invoke("browser:logout"), status: (refresh?: boolean) => ipcRenderer.invoke("browser:status", refresh), navigate: (url) => ipcRenderer.invoke("browser:navigate", url), setBounds: (bounds) => ipcRenderer.invoke("browser:setBounds", bounds), setVisible: (visible) => ipcRenderer.invoke("browser:setVisible", visible) },
  automation: { start: (projectId) => ipcRenderer.invoke("automation:start", projectId), retry: (projectId) => ipcRenderer.invoke("automation:retry", projectId) },
  settings: { get: () => ipcRenderer.invoke("settings:get"), getApiKey: () => ipcRenderer.invoke("settings:getApiKey"), save: (input) => ipcRenderer.invoke("settings:save", input), test: (input) => ipcRenderer.invoke("settings:test", input) },
  events: { onProjectUpdated(listener) { const handler = (_event: Electron.IpcRendererEvent, project: unknown) => listener(project as never); ipcRenderer.on("project:updated", handler); return () => ipcRenderer.removeListener("project:updated", handler); } },
};
contextBridge.exposeInMainWorld("vbk", api);
