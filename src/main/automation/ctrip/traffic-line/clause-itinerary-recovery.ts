/** A late resource settlement can rebind the child to its parent's itinerary. */
export async function settleTrafficLineClausesBeforeActivation(args: {
  settleClauses: () => Promise<void>;
  itineraryNeedsRepair: () => Promise<boolean>;
  repairItinerary: () => Promise<unknown>;
  saveClauses: () => Promise<unknown>;
  verifyClauses: () => Promise<unknown>;
}): Promise<void> {
  try {
    await args.settleClauses();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/子产品资源回读尚未生成(?:飞机|火车)去返程条款/.test(message)) throw error;
    // Prove the actual itinerary regression before any corrective write.
    // Missing resources, ambiguous versions and request failures never enter here.
    if (!await args.itineraryNeedsRepair()) throw error;
    await args.repairItinerary();
    await args.saveClauses();
    await args.verifyClauses();
  }
}
