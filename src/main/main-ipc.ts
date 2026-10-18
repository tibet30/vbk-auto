import { registerProductAiIpc } from "./ipc/product-ai-ipc.js";
import { registerRemoteProductIpc } from "./ipc/remote-product-ipc.js";
import { registerBrowserAutomationIpc } from "./ipc/browser-automation-ipc.js";
import { registerHotelDraftRetryIpc } from "./ipc/hotel-draft-retry-ipc.js";
import { registerItineraryReviewUnlockIpc } from "./ipc/itinerary-review-unlock-ipc.js";
import { registerSettingsIpc } from "./ipc/settings-ipc.js";
import { registerPlanningV2Ipc } from "./ipc/planning-v2-ipc.js";
import { registerAppAuthIpc } from "./ipc/app-auth-ipc.js";
import { registerAgentIpc } from "./ipc/agent-ipc.js";
import { registerMemoryIpc } from "./ipc/memory-ipc.js";
import { registerUpdateIpc } from "./ipc/update-ipc.js";

// 规划入口仅由 v2 注册。旧 registerPlanningIpc（src/main/ipc/planning-ipc.ts）
// 是 deprecated 历史文件，仅留作单测直接驱动 plan-orchestrator.runPlan。
// 这里**不**调用它，否则 Electron 会因 planning:start 重复注册立即抛错。
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
  registerHotelDraftRetryIpc(context);
  registerItineraryReviewUnlockIpc(context);
  registerSettingsIpc(context);
  registerPlanningV2Ipc(context);
  registerAgentIpc(context);
  registerMemoryIpc(context);
  registerUpdateIpc(updateService);
}
