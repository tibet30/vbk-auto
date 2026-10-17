import { createHash } from "node:crypto";
import type { AutomationRun, ProductDetail } from "../../shared/contracts.js";
import { canonicalJson, record } from "../../shared/product-storage-projection.js";

type Json = Record<string, unknown>;

function hash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function basicInfo(product: Json): Json {
  const basic = structuredClone(record(product.basicInfo));
  // Generated for one remote shell; it is output evidence, not planning input.
  delete basic.supplierProductCode;
  return basic;
}

function sales(product: Json): Json {
  return structuredClone(record(product.sales));
}

function itinerary(product: Json): unknown[] {
  return structuredClone(Array.isArray(product.itinerary) ? product.itinerary : []);
}

function presentation(product: Json): Json {
  return structuredClone(record(product.presentation));
}

function commercial(product: Json): Json {
  return structuredClone(record(product.commercial));
}

function operations(product: Json): Json {
  const value = structuredClone(record(product.operations));
  const hotel = record(value.hotelResource);
  // IDs and candidate mirrors are produced by VBK resource resolution. Keep
  // operator-entered query/room choices and the platform matching policy.
  delete hotel.resourceId;
  delete hotel.supplierCode;
  delete hotel.candidates;
  delete hotel.dailyCandidates;
  if (Object.keys(hotel).length) value.hotelResource = hotel;
  else delete value.hotelResource;
  const traffic = record(value.trafficLine);
  delete traffic.availability;
  if (Object.keys(traffic).length) value.trafficLine = traffic;
  else delete value.trafficLine;
  return value;
}

function itinerarySpotIdentity(product: Json): unknown[] {
  return itinerary(product).map((value) => {
    const day = record(value);
    return {
      day: day.day,
      spots: (Array.isArray(day.spots) ? day.spots : []).map((spot) => {
        const item = record(spot);
        return { name: item.name, kind: item.kind, poiId: item.poiId, poiName: item.poiName };
      }),
    };
  });
}

function hotelPlan(product: Json): unknown {
  return {
    basicInfo: basicInfo(product),
    itinerary: itinerary(product).map((value) => {
      const day = record(value);
      return {
        day: day.day,
        hotel: day.hotel,
        hotelCity: day.hotelCity,
        hotelRequirement: day.hotelRequirement,
        hotelCandidates: day.hotelCandidates,
      };
    }),
    operations: operations(product),
  };
}

/** Stable planning input consumed by one VBK entry phase. */
export function entryPhaseInput(product: Json, phase: string): unknown {
  const basic = basicInfo(product);
  const sale = sales(product);
  const trip = itinerary(product);
  const copy = presentation(product);
  const money = commercial(product);
  const ops = operations(product);
  switch (phase) {
    case "basic":
      return { basicInfo: basic, sales: sale, keySpots: itinerarySpotIdentity(product),
        pickupCity: ops.pickupCity, butler: ops.butler };
    case "presentation":
      return { presentation: copy, productForm: sale.productForm, keySpots: itinerarySpotIdentity(product) };
    case "itinerary":
      return { basicInfo: basic, sales: sale, itinerary: trip };
    case "package":
      return { basicInfo: basic, sales: sale, itineraryDays: trip.length,
        presentation: { recommendation: copy.recommendation }, commercial: { packageName: money.packageName } };
    case "pricingInventory":
      return { sales: sale, pricing: money.pricing, inventory: money.inventory,
        packageName: money.packageName, basicInfo: basic };
    case "hotelResource":
      return hotelPlan(product);
    case "vehicleResource":
      return { basicInfo: basic, sales: sale, itinerary: trip, operations: ops };
    case "terms":
      return { sales: sale, itinerary: trip, operations: ops, commercial: money };
    case "trafficLine":
      return { basicInfo: basic, itinerary: trip, trafficLine: record(ops.trafficLine) };
    case "preflight":
      return { basicInfo: basic, sales: sale, itinerary: trip, presentation: copy,
        commercial: money, operations: ops };
    default:
      throw new Error(`未知的 VBK 录入阶段：${phase}`);
  }
}

export function entryPhaseInputFingerprint(product: Json, phase: string): string {
  return hash(entryPhaseInput(product, phase));
}

export function stampCompletedEntryPhase(run: AutomationRun, product: Json, phase: string): void {
  const row = run.phases.find((item) => item.phase === phase);
  if (row?.status === "completed") row.inputFingerprint = entryPhaseInputFingerprint(product, phase);
}

export function completedEntryPhaseIsCurrent(product: ProductDetail, phase: string): boolean | undefined {
  const row = product.automation?.phases.find((item) => item.phase === phase && item.status === "completed");
  if (!row) return false;
  if (!row.inputFingerprint) return undefined;
  return row.inputFingerprint === entryPhaseInputFingerprint(product.product, phase);
}
