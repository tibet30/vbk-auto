import { productNeedsVehicleResource } from '../../src/shared/product-form.js';
import type { PreparationEvaluation } from '../../src/shared/contracts-preparation.js';
import type { Json } from './corpus.js';

export function gateResults(product: Json, evaluation: PreparationEvaluation) {
  return Object.fromEntries(['foundation', 'itinerary', 'poi', 'hotel', 'copy', 'presentation',
    'commercial', 'cover', 'vehicle', 'traffic', 'validation'].map(code => {
    const notRequired = code === 'vehicle' && !productNeedsVehicleResource(product)
      || code === 'traffic' && !product.operations?.trafficLine?.enabled;
    const blocked = evaluation.gaps.some(gap => gap.code === code);
    return [code, blocked ? 'blocked' : notRequired ? 'not_required' : 'passed'];
  }));
}
