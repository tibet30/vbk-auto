import type { PoiSuggestDetailResult, CtripLibrarySearchResult } from '../../shared/contracts-types.js';
import type { Page } from 'playwright';

/** Query projections only. Selection, mutation, generation and gates remain production responsibilities. */
export interface ResourceQueryOverrides {
  poi?(keyword: string, context?: { destinationCity?: string; province?: string }): Promise<PoiSuggestDetailResult>;
  poiAvailability?(poiId: number): Promise<{ status: 'available' | 'suspended' }>;
  hotelFetch?: typeof fetch;
  coverSearch?(page: Page, keyword: string): Promise<CtripLibrarySearchResult>;
}
