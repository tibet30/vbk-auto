import type { ProductDetail } from '../../shared/contracts.js';
import type { Page } from 'playwright';
import type { VbkDatabase } from './database/database.js';
import { platformResourceGateway } from './platform-resource-gateway.js';
import { suggestPoiDetail } from './poi-suggest.js';
import { searchVbkResources, firstHotelResource } from '../operations/hotel-resource.js';
import { buildVehicleResourceQuery, searchVehicleResourceGroups, extractResourceGroups, bestResourceGroup,
  resolveVehicleResource } from '../operations/vehicle-resource.js';
import { searchAirports, searchTrainStations } from '../automation/ctrip/itinerary-api/station-search.js';
import { getProductBaseInfoApi } from '../automation/ctrip/basic-info/api.js';
import { applyAutoCoverFill } from '../operations/cover-auto-fill.js';

/** Domain-specific business results. Raw platform parsing stays behind this adapter. */
export function platformBusinessQueries(db: VbkDatabase, id: string, page: Page) {
  const gateway = platformResourceGateway(db, id);
  return {
    poi(keyword: string, context?: Parameters<typeof suggestPoiDetail>[2]) {
      return gateway.query('poi', { keyword, context }, () => suggestPoiDetail(page, keyword, context), value => !value.candidates.length);
    },
    hotelLibrary(city: string) {
      return gateway.query('hotel_library', { city }, async () => {
        const payload = await searchVbkResources(page);
        return { selected: firstHotelResource(payload, city), payload };
      }, value => !value.selected);
    },
    vehicle(input: Parameters<typeof buildVehicleResourceQuery>[0]) {
      const query = buildVehicleResourceQuery(input);
      return gateway.query('vehicle_groups', query, async () => {
        const payload = await searchVehicleResourceGroups(page, query.query);
        return { query, selected: bestResourceGroup(payload), groups: extractResourceGroups(payload) };
      }, value => !value.groups.length);
    },
    station(keyword: string, kind: 'airport' | 'train') {
      return gateway.query('traffic_station', { keyword, kind }, () => kind === 'train'
        ? searchTrainStations(page, keyword) : searchAirports(page, keyword), value => !value.length);
    },
    mother(productId: string) {
      return gateway.query('mother_readback', { productId }, () => getProductBaseInfoApi(page, productId));
    },
    cover(product: Record<string, unknown>, injectSearch?: Parameters<typeof applyAutoCoverFill>[0]['injectSearch'],
      options: Pick<Parameters<typeof applyAutoCoverFill>[0], 'generateCover' | 'inspectManualCover'> = {}) {
      return gateway.query('cover', { itinerary: product.itinerary, presentation: product.presentation },
        () => applyAutoCoverFill({ page, product, injectSearch, ...options }), undefined, 'ctrip');
    },
    resolveVehicle(product: ProductDetail) {
      return gateway.query('vehicle_groups', product.product.operations, () => resolveVehicleResource(page, product));
    },
  };
}
