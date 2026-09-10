/** Adapter that lets initial planning read traffic availability without reversing its layer dependency. */

import type { VbkDatabase } from "../../../infrastructure/database/database.js";
import type { VbkBrowser } from "../../../infrastructure/vbk-browser.js";
import type { TrafficLineEndpointAvailability } from "../../../../shared/contracts-traffic-line.js";
import {
  preflightTrafficLineEndpoints,
  type TrafficLineStationDisambiguator,
} from "./endpoints.js";

export async function resolveProductTrafficLineAvailability(args: {
  db: VbkDatabase;
  browser: VbkBrowser;
  localProductId: string;
  runVbkPageExclusive?: <T>(task: () => Promise<T>) => Promise<T>;
  /** 多站点城市必须由受控决策从当前候选中选择，不能静默关闭大交通。 */
  disambiguateStation?: TrafficLineStationDisambiguator;
}): Promise<TrafficLineEndpointAvailability | null> {
  const product = args.db.getProduct(args.localProductId);
  if (!product || !Array.isArray(product.product.itinerary)) return null;
  const query = async () => {
    const page = await args.browser.page();
    return preflightTrafficLineEndpoints(
      page,
      product.product.itinerary as Array<{ spots?: Array<{
      name?: string | null;
      poiName?: string | null;
      poiId?: number | null;
      city?: string | null;
    }> }>,
      new Date(), args.disambiguateStation, product.product,
      ["flightRoundTrip", "trainRoundTrip"], { allowPartialAvailabilityOnUncertain: true },
    );
  };
  return args.runVbkPageExclusive ? args.runVbkPageExclusive(query) : query();
}
