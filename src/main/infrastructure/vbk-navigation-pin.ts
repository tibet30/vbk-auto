export interface VbkNavigationPin {
  allowedProductIds: string[];
  allowCreateSetup: boolean;
}

export function extractVbkProductId(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return parsed.searchParams.get("productId") || parsed.searchParams.get("productid") || undefined;
  } catch {
    return undefined;
  }
}

export function isPinnedVbkNavigationAllowed(url: string, pin: VbkNavigationPin | null): boolean {
  if (!pin) return true;
  try {
    const parsed = new URL(url);
    if (pin.allowCreateSetup && /saleControlMerge/i.test(parsed.pathname)) return true;
    const productId = parsed.searchParams.get("productId") || parsed.searchParams.get("productid");
    return Boolean(productId && pin.allowedProductIds.includes(productId));
  } catch {
    return false;
  }
}
