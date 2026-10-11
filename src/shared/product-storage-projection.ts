import type { ProductPlan, ProductResourceEvidence } from './contracts-product-architecture.js';

type Json = Record<string, unknown>;
export function record(value: unknown): Json {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
}

/** Lossless split; candidate choices remain in the composed approval projection. */
export function splitProduct(product: Json, source: ProductResourceEvidence['source'] = 'verified') {
  const plan: ProductPlan = structuredClone(product);
  const diagnostics = record(plan.diagnostics);
  delete plan.diagnostics;
  const fields: ProductResourceEvidence['fields'] = [];
  const take = (object: Json, key: string, path: string[]) => {
    if (Object.hasOwn(object, key)) {
      fields.push({ path: [...path, key], value: object[key] });
      delete object[key];
    }
  };
  take(diagnostics, 'routeAdministrativeNodes', ['diagnostics']);
  const days = Array.isArray(plan.itinerary) ? plan.itinerary : [];
  const candidates = days.flatMap(day => Array.isArray(record(day).hotelCandidates)
    ? record(day).hotelCandidates as unknown[] : []);
  days.forEach((day, index) => take(record(day), 'hotelCandidates', ['itinerary', String(index)]));
  const ops = record(plan.operations);
  take(record(ops.trafficLine), 'availability', ['operations', 'trafficLine']);
  const hotel = record(ops.hotelResource);
  if (candidates.length) {
    if (candidates.some(candidate => record(candidate).hotelName === hotel.resourceName) && !hotel.query && !hotel.roomType) {
      take(ops, 'hotelResource', ['operations']);
    } else {
      for (const key of ['candidates', 'dailyCandidates', 'resourceId', 'supplierCode']) {
        take(hotel, key, ['operations', 'hotelResource']);
      }
    }
  }
  const evidence: ProductResourceEvidence = { version: 1, source, fields,
    diagnosticsPresent: Object.hasOwn(product, 'diagnostics') };
  return { plan, evidence, diagnostics };
}

export function composeProduct(plan: ProductPlan, evidence: ProductResourceEvidence, diagnostics: Json): Json {
  const product = structuredClone(plan);
  if (evidence.diagnosticsPresent || Object.keys(diagnostics).length) product.diagnostics = structuredClone(diagnostics);
  for (const { path, value } of evidence.fields) {
    let target: Json = product;
    for (const segment of path.slice(0, -1)) {
      if (!target[segment] || typeof target[segment] !== 'object') target[segment] = {};
      target = target[segment] as Json;
    }
    target[path[path.length - 1]!] = structuredClone(value);
  }
  return product;
}

export function canonicalJson(value: unknown): string {
  const sort = (item: unknown): unknown => Array.isArray(item) ? item.map(sort)
    : item && typeof item === 'object' ? Object.fromEntries(Object.entries(item)
      .sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, sort(child)])) : item;
  return JSON.stringify(sort(value));
}
