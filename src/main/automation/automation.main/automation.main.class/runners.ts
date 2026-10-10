/**
 * DraftAutomation 私有 helper：
 *   - runContext：构造 AutomationRunContext，封装 db / browser / emit / guard /
 *     mutations / advisor / presentationCopyRewriter / disambiguator /
 *     cancellationRequested / exclusive 闭包；
 *   - run / runApproved / runOnePhase / runSaleControl：分别委托给对应 flow；
 *   - runExclusive：底层「同一 localProductId 互斥」包装；
 *   - withNavigationPin：注入自动化导航钉，离开时清理。
 *
 * 拆出来的目的：把主类 DraftAutomation 的骨架压缩到 100 行内，便于在
 * barrel 文件里一目了然地看到业务面 API 与 lifecycle 钩子。
 */

import { runAutomationExclusive } from "../automation.main.execution.js";
import { runAutomation as runAutomationFlow } from "../automation.main.run.js";
import { runOnePhase as runOnePhaseFlow } from "../automation.main.run-one.js";
import { runSaleControlPhase } from "../automation.main.run-sale-control.js";
import { makeAutomationRunContext } from "../automation.main.make-context.js";
import { automationNavigationPin } from "../automation.main.pin.js";
import type { AutomationRunContext } from "../automation.main.context.js";
import type { VbkBrowser } from "../../../infrastructure/vbk-browser.js";
import type { VbkDatabase } from "../../../infrastructure/database/database.js";
import type { AdvisorOutcome, AdvisorRequest, AiResponse, ProductDetail } from "../../../../shared/contracts.js";
import type { ProductMutationService } from "../../../application/product-mutation-service.js";

export interface RunContextBindings {
  db: VbkDatabase;
  browser: VbkBrowser;
  onUpdate: (product: ProductDetail) => void;
  advisor: (req: AdvisorRequest) => Promise<AdvisorOutcome>;
  disambiguator?: (req: {
    kind: "province" | "city" | "spot" | "station";
    stationSubtype?: "airport" | "train";
    desired: string;
    candidates: Array<{ id?: string; text: string }>;
    product: Record<string, unknown>;
  }) => Promise<{ pickedText: string | null; reasoning: string }>;
  presentationCopyRewriter?: (req: { message: string; product: Record<string, unknown> }) => Promise<AiResponse>;
  productMutations?: ProductMutationService;
  agentWriteGuard?: (localProductId: string, phase: string) => Promise<void>;
  running: Set<string>;
  cancellationRequested: Set<string>;
  exclusive?: <T>(task: () => Promise<T>) => Promise<T>;
}

export function buildRunContext(bindings: RunContextBindings, localProductId?: string, phase?: string): AutomationRunContext {
  return makeAutomationRunContext({
    db: bindings.db,
    browser: bindings.browser,
    emit: (id: string) => {
      const product = bindings.db.getProduct(id);
      if (product) bindings.onUpdate(product);
    },
    localProductId,
    guard: bindings.agentWriteGuard,
    mutations: bindings.productMutations,
    advisor: bindings.advisor,
    presentationCopyRewriter: bindings.presentationCopyRewriter,
    disambiguator: bindings.disambiguator,
    cancellationRequested: bindings.cancellationRequested,
    exclusive: bindings.exclusive ?? (<T>(task: () => Promise<T>) => task()),
  });
}

export async function runFull(bindings: RunContextBindings, ctx: AutomationRunContext, localProductId: string, retryFrom?: string) {
  return runAutomationFlow(ctx, localProductId, retryFrom);
}

export async function runOne(bindings: RunContextBindings, ctx: AutomationRunContext, localProductId: string, phase: string) {
  return runOnePhaseFlow(ctx, localProductId, phase);
}

export async function runSaleControl(bindings: RunContextBindings, ctx: AutomationRunContext, localProductId: string) {
  return runSaleControlPhase(ctx, localProductId);
}

export function runExclusive<T>(bindings: RunContextBindings, localProductId: string, work: () => Promise<T>) {
  return runAutomationExclusive({
    localProductId,
    running: bindings.running,
    cancellationRequested: bindings.cancellationRequested,
    clock: bindings.db.executionClock,
    work: () => withNavigationPin(bindings, localProductId, work),
  });
}

async function withNavigationPin<T>(bindings: RunContextBindings, localProductId: string, work: () => Promise<T>): Promise<T> {
  bindings.browser.pinProductNavigation?.(automationNavigationPin(bindings.db.getProduct(localProductId)));
  try {
    return await work();
  } finally {
    bindings.browser.clearNavigationPin?.();
  }
}