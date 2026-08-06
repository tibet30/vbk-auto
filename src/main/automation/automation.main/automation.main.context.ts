import type { AdvisorOutcome, AdvisorRequest, AutomationRun, ContactCardSelection } from "../../../shared/contracts.js";
import type { VbkDatabase } from "../../infrastructure/database/database.js";
import type { VbkBrowser } from "../../infrastructure/vbk-browser.js";

export interface ActiveButlerContext {
  accountName: string;
  butlerSelection: ContactCardSelection;
  servicePhone: string;
  fallbackUsed: boolean;
}

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
  emit: (projectId: string) => void;
  markCancelled: (projectId: string, run: AutomationRun, persist: () => void) => void;
  cancellationRequested: Set<string>;
  ensureBrowserHasBounds: () => void;
}
