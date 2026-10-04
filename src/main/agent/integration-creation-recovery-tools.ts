import { getVbkRequestPage } from "../infrastructure/vbk-request-page.js";
import { readItineraryDraftDiagnostic } from "../automation/ctrip/itinerary-api/draft-diagnostics.js";
import { runProductReadOnlyPreflightApi } from "../automation/ctrip/preflight-readonly.js";
import { productSectionUrl } from "../automation/constants.js";
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

/** First-created unsubmitted itineraries can omit the separate draft relation. */
function unsubmittedMain(diagnostic: Awaited<ReturnType<typeof readItineraryDraftDiagnostic>>) {
  if (diagnostic.versions.some((item) => item.version === "draft")) return undefined;
  const main = diagnostic.versions.find((item) => item.version === "formal");
  const audit = diagnostic.versions.find((item) => item.version === "audit");
  const preview = diagnostic.versions.find((item) => item.version === "preview");
  const mainId = validVersionId(main?.tourInfoId);
  if (!main || !mainId || !audit || !preview || main.detail !== "available"
    || audit.detail !== "available" || preview.detail !== "available"
    || validVersionId(audit.tourInfoId) !== mainId
    || !validVersionId(preview.tourInfoId) || validVersionId(preview.tourInfoId) === mainId
    || !isSavedUnsubmittedDraft(main.statuses.draftTourInfoStatus)
    || !isSavedUnsubmittedDraft(main.statuses.auditTourInfoStatus)
    || main.statuses.auditStatus?.key !== "N"
    || main.statuses.auditStatus?.value !== "未提交") return undefined;
  return main;
}

/** Historical formal/audit approval never substitutes for saved draft evidence. */
export async function readCreationVariant(page: unknown, productId: string): Promise<CreationVariantReadback> {
  const diagnostic = await readItineraryDraftDiagnostic(page as Parameters<typeof readItineraryDraftDiagnostic>[0], productId);
  const ids = Object.fromEntries(diagnostic.versions
    .filter((item) => item.tourInfoId !== null)
    .map((item) => [item.version, String(item.tourInfoId)]));
  const explicitDraft = diagnostic.versions.find((item) => item.version === "draft");
  const draft = explicitDraft ?? unsubmittedMain(diagnostic);
  const suffixName = draft?.poi85862?.suffixName?.name;
  const draftId = validVersionId(draft?.tourInfoId);
  const isVerifiedDraft = Boolean(
    draft && draftId && draft.detail === "available"
    && isSavedUnsubmittedDraft(draft.statuses.draftTourInfoStatus)
    && (!explicitDraft || isIndependentDraft(diagnostic, draftId)),
  );
  if (isVerifiedDraft && draftId) ids.draft = draftId;
  return {
    variant: isVerifiedDraft ? "draft" : "unknown",
    unsubmittedDraftVerified: isVerifiedDraft,
    ...(isVerifiedDraft ? { draftSource: explicitDraft ? "independent" as const : "unsubmitted-main" as const } : {}),
    ids,
    ...(draft?.poi85862 ? { poi85862: {
      ...(typeof suffixName === "string" ? { suffixName } : {}),
      ...(typeof draft.poi85862.description === "string" ? { description: draft.poi85862.description } : {}),
    } } : {}),
  };
}

export function readCreationRecoveryPreflight(
  page: Parameters<typeof runProductReadOnlyPreflightApi>[0],
  product: Parameters<typeof runProductReadOnlyPreflightApi>[1],
  productId: string,
  options: Parameters<typeof runProductReadOnlyPreflightApi>[3],
  readPreflight = runProductReadOnlyPreflightApi,
) {
  const read = () => readPreflight(page, product, productId, options);
  // Native recovery has no active editor. Never borrow another visible product.
  return typeof page.withRequestSource === "function"
    ? page.withRequestSource(productSectionUrl(productId, "basic"), read)
    : read();
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
    readPreflight: readCreationRecoveryPreflight,
  });
}
