import { getVbkRequestPage } from "../infrastructure/vbk-request-page.js";
import { readItineraryDraftDiagnostic } from "../automation/ctrip/itinerary-api/draft-diagnostics.js";
import { createVbkCreationRecoveryTools, type CreationVariantReadback } from "./creation-recovery-readonly.js";
import type { AgentBusinessDependencies } from "./integration-generate.js";
import { agentProductVersion } from "./integration-gates.js";
import type { AgentTool } from "./types.js";

type GetProduct = (localProductId: string) => { productId?: string; vbkAccount?: string };

function isSavedUnsubmittedDraft(status: unknown): boolean {
  return status === 1 || status === "1";
}

function validVersionId(value: unknown): string | undefined {
  const id = typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
  return /^[1-9]\d*$/.test(id) ? id : undefined;
}

function isIndependentDraft(diagnostic: Awaited<ReturnType<typeof readItineraryDraftDiagnostic>>, draftId: string): boolean {
  return !diagnostic.versions
    .filter((item) => item.version === "formal" || item.version === "audit" || item.version === "preview")
    .some((item) => validVersionId(item.tourInfoId) === draftId);
}

/**
 * A recovery may only use the explicit draft relation. Formal/audit IDs are
 * returned for diagnosis but never promoted to draft evidence; a historical
 * formal approval therefore cannot reject a freshly saved draft.
 */
export async function readCreationVariant(page: unknown, productId: string): Promise<CreationVariantReadback> {
  const diagnostic = await readItineraryDraftDiagnostic(page as Parameters<typeof readItineraryDraftDiagnostic>[0], productId);
  const ids = Object.fromEntries(diagnostic.versions
    .filter((item) => item.tourInfoId !== null)
    .map((item) => [item.version, String(item.tourInfoId)]));
  const draft = diagnostic.versions.find((item) => item.version === "draft");
  const suffixName = draft?.poi85862?.suffixName?.name;
  const draftId = validVersionId(draft?.tourInfoId);
  const isVerifiedDraft = Boolean(
    draft && draftId && draft.detail === "available"
    && isSavedUnsubmittedDraft(draft.statuses.draftTourInfoStatus)
    && isIndependentDraft(diagnostic, draftId),
  );
  return {
    variant: isVerifiedDraft ? "draft" : "unknown",
    unsubmittedDraftVerified: isVerifiedDraft,
    ids,
    ...(draft?.poi85862 ? { poi85862: {
      ...(typeof suffixName === "string" ? { suffixName } : {}),
      ...(typeof draft.poi85862.description === "string" ? { description: draft.poi85862.description } : {}),
    } } : {}),
  };
}

/** Keeps recovery wiring out of the primary Agent integration factory. */
export function createCreationRecoveryTools(deps: AgentBusinessDependencies, get: GetProduct): AgentTool[] {
  return createVbkCreationRecoveryTools({
    db: deps.db,
    browser: { page: () => getVbkRequestPage(deps.browser) },
    productWorkflows: deps.productWorkflows,
    // execute() already owns runVbkPageExclusive for the whole remote read. A
    // nested acquisition would queue behind itself because the coordinator is
    // deliberately FIFO and non-reentrant.
    accountFor: async (localProductId) => {
      const product = get(localProductId);
      const login = await deps.browser.status(true);
      const accountKey = login.loginAccount?.trim() || login.accountName?.trim();
      if (!login.loggedIn || !accountKey || (product.vbkAccount && product.vbkAccount !== accountKey)) {
        throw new Error("请登录产品绑定的 VBK 账号再进行恢复读取。");
      }
      return { accountKey, productVersion: agentProductVersion(deps.db.getProduct(localProductId)!) };
    },
    readCreationVariant, emitProduct: deps.emitProduct,
  });
}
