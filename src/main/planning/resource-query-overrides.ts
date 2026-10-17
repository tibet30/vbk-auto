import type { PoiSuggestDetailResult, CtripLibrarySearchResult } from '../../shared/contracts-types.js';
import type { Page } from 'playwright';
import type { ProductForm } from '../../shared/product-form.js';
import type { RecommendationCategoryPolicy } from '../../shared/recommendation-category-policy.js';

/** Query projections only. Selection, mutation, generation and gates remain production responsibilities. */
export interface ResourceQueryOverrides {
  recommendationCategoryPolicy?(productForm: ProductForm): Promise<RecommendationCategoryPolicy>;
  poi?(keyword: string, context?: { destinationCity?: string; province?: string }): Promise<PoiSuggestDetailResult>;
  poiAvailability?(poiId: number): Promise<{ status: 'available' | 'suspended' }>;
  hotelFetch?: typeof fetch;
  coverGenerationFetch?: typeof fetch;
  coverSearch?(page: Page, keyword: string): Promise<CtripLibrarySearchResult>;
}
