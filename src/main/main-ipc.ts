import { registerProductAiIpc } from "./ipc/product-ai-ipc.js";
import { registerRemoteProductIpc } from "./ipc/remote-product-ipc.js";
import { registerBrowserAutomationIpc } from "./ipc/browser-automation-ipc.js";
import { registerSettingsIpc } from "./ipc/settings-ipc.js";
import { registerPlanningV2Ipc } from "./ipc/planning-v2-ipc.js";
import { registerAppAuthIpc } from "./ipc/app-auth-ipc.js";
import { registerAgentIpc } from "./ipc/agent-ipc.js";
import { registerMemoryIpc } from "./ipc/memory-ipc.js";
import { registerUpdateIpc } from "./ipc/update-ipc.js";
import type { MainIpcContext } from "./ipc/context.js";
import type { TibetAuthService } from "./infrastructure/tibet-auth.js";
import type { AppUpdateService } from "./application/app-update-service.js";

export function registerMainIpc(
  context: MainIpcContext,
  appAuth: TibetAuthService,
  updateService: AppUpdateService,
  onAuthenticated?: Parameters<typeof registerAppAuthIpc>[1],
): void {
  registerAppAuthIpc(appAuth, onAuthenticated);
  registerRemoteProductIpc(context);
  registerProductAiIpc(context);
  registerBrowserAutomationIpc(context);
  registerSettingsIpc(context);
  registerPlanningV2Ipc(context);
  registerAgentIpc(context);
  registerMemoryIpc(context);
  registerUpdateIpc(updateService);
}
