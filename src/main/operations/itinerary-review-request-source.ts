import { productSectionUrl } from "../automation/constants.js";
import type { VbkSessionRequestBrowser } from "../infrastructure/vbk-session-request.js";

type SourceAwarePage = VbkSessionRequestBrowser & {
  withRequestSource?: <T>(url: string, execute: () => Promise<T>) => Promise<T>;
};

/** Binds review API reads and writes to the official itinerary editor without navigating BrowserView. */
export function itineraryReviewRequestSource(page: VbkSessionRequestBrowser, productId: string): VbkSessionRequestBrowser {
  const sourcePage = page as SourceAwarePage;
  if (!sourcePage.withRequestSource) return page;
  const source = productSectionUrl(productId, "itinerary");
  const withinSource = <T>(execute: () => Promise<T>) => sourcePage.withRequestSource!(source, execute);
  return {
    nativeOnly: page.nativeOnly,
    evaluate: page.evaluate.bind(page),
    vbkSessionFetch: page.vbkSessionFetch && (request => withinSource(() => page.vbkSessionFetch!(request))),
    vbkSessionGetText: page.vbkSessionGetText && (request => withinSource(() => page.vbkSessionGetText!(request))),
  };
}
