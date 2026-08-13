/**
 * automation.main 模块用到的两个共享类型：
 *   - ActiveButlerContext：当前可用的管家 / 400 电话上下文（含 fallbackUsed 标记）；
 *   - AutomationRunContext：run / runOnePhase 阶段需要使用的全部依赖（db/browser/advisor/disambiguator、
 *     emit/markCancelled/cancellationRequested/ensureBrowserHasBounds）。
 *
 * 本文件只做类型声明，不引入运行时依赖；具体实现见 ./automation.main.class.ts 等。
 */

import type { AdvisorOutcome, AdvisorRequest, AutomationRun, ContactCardSelection } from "../../../shared/contracts.js";
import type { VbkDatabase } from "../../infrastructure/database/database.js";
import type { VbkBrowser } from "../../infrastructure/vbk-browser.js";

/**
 * 当前可用管家账号上下文：
 *   - accountName：来源于 vbkAccountName；
 *   - butlerSelection：从账号固定信息解析出的管家联系卡；
 *   - servicePhone：同源 400 电话；
 *   - fallbackUsed：true 时表示是从已知账号回退而非当前账号找到的（用于让上层写回 vbkAccountName）。
 */
export interface ActiveButlerContext {
  accountName: string;
  butlerSelection: ContactCardSelection;
  servicePhone: string;
  fallbackUsed: boolean;
}

/**
 * 阶段 runner 共享上下文：所有 helper（advisor / disambiguator / ensureBrowserHasBounds 等）
 * 都通过这个对象注入，便于测试时替换。
 */
export interface AutomationRunContext {
  db: VbkDatabase;
  browser: VbkBrowser;
  advisor: (req: AdvisorRequest) => Promise<AdvisorOutcome>;
  disambiguator?: (req: {
    kind: "province" | "city" | "spot" | "station";
    desired: string;
    candidates: Array<{ id?: string; text: string }>;
    product: Record<string, unknown>;
  }) => Promise<{ pickedText: string | null; reasoning: string }>;
  resolveActiveButlerContext: (accountName?: string) => ActiveButlerContext | null;
  emit: (localProductId: string) => void;
  markCancelled: (localProductId: string, run: AutomationRun, persist: () => void) => void;
  cancellationRequested: Set<string>;
  ensureBrowserHasBounds: () => void;
}
