import type { AutomationRun, ProductDetail } from '../../src/shared/contracts.js';
import { draftPhasesFor } from '../../src/main/automation/automation.main/automation.main.phases.js';
import { parseProduct } from '../../src/main/automation/schema/schema.js';

/** Durable fixture proof for every required mother phase, rather than an ID/status shortcut. */
export function verifiedAutomation(product: ProductDetail): AutomationRun {
  Object.assign(product.product.basicInfo!, { subtitle: '城市游览', province: '四川', operationNotes: '按行程安排' });
  Object.assign(product.product.operations!, { pickupCity: '成都' });
  product.product.itinerary = Array.from({ length: Number((product.product.basicInfo as Record<string, unknown>).days) }, (_, index) =>
    ({ day: index + 1, title: '城市游览', spots: [], description: '游览', hotel: '', meals: '自理' }));
  return { id: 'proof', status: 'succeeded', logs: [],
    phases: draftPhasesFor(parseProduct(product.product)).map(phase => ({ phase, status: 'completed' })) };
}
