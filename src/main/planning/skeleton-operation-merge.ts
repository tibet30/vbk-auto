/** Regenerating the skeleton only owns its own fields, not verified resources or traffic. */
export function mergeSkeletonOperations(
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  const merged = { ...existing, ...incoming };
  if (incoming.hotelTier !== undefined && incoming.hotelTier !== existing.hotelTier) {
    delete merged.hotelResource;
  }
  return merged;
}
