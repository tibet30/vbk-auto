export type CaptureScalar = string | number | boolean | null;
export type CaptureRecordLocation = "body" | "tourInfo" | "productTourInfo" | "result" | "tourDaily";

export interface ItineraryDraftCaptureLocations {
  saveType: CaptureRecordLocation[];
  tourInfoId: CaptureRecordLocation[];
  draftTourInfoId: CaptureRecordLocation[];
  auditTourInfoId: CaptureRecordLocation[];
  previewTourInfoId: CaptureRecordLocation[];
  auditTourInfoStatus: CaptureRecordLocation[];
  draftTourInfoStatus: CaptureRecordLocation[];
  auditStatus: CaptureRecordLocation[];
}

/** Redacted per-record scalars let us distinguish `tourDaily` from outer IDs. */
export interface ItineraryDraftCaptureVersionValues {
  tourInfoId: Array<{ location: CaptureRecordLocation; value: CaptureScalar }>;
  draftTourInfoId: Array<{ location: CaptureRecordLocation; value: CaptureScalar }>;
  auditTourInfoId: Array<{ location: CaptureRecordLocation; value: CaptureScalar }>;
  previewTourInfoId: Array<{ location: CaptureRecordLocation; value: CaptureScalar }>;
  auditTourInfoStatus: Array<{ location: CaptureRecordLocation; value: CaptureScalar }>;
  draftTourInfoStatus: Array<{ location: CaptureRecordLocation; value: CaptureScalar }>;
}

type LocatedScalar = { location: CaptureRecordLocation; value: CaptureScalar };

export interface ItineraryDraftCaptureProtocolValues {
  isModify: LocatedScalar[];
  isNew: LocatedScalar[];
  fromTourInfoId: LocatedScalar[];
  /** First-day gather airport only; no daily content is retained. */
  firstGatherAirport: Array<{ location: CaptureRecordLocation; code: CaptureScalar; name: CaptureScalar }>;
  /** Counts and presence flags only; never hotel names, IDs, or full nodes. */
  hotelShapes: Array<{
    location: CaptureRecordLocation;
    hotelInfoCount: number;
    tourDailyHotelsCount: number;
    packageHotelsCount: number;
    hotelIdPresent: boolean;
    gradePresent: boolean;
  }>;
}

export interface ItineraryDraftCapturePayload {
  saveType: CaptureScalar;
  tourInfoId: CaptureScalar;
  draftTourInfoId: CaptureScalar;
  auditTourInfoId: CaptureScalar;
  previewTourInfoId: CaptureScalar;
  auditTourInfoStatus: CaptureScalar;
  draftTourInfoStatus: CaptureScalar;
  auditStatusKey: CaptureScalar;
  auditStatusValue: CaptureScalar;
  locations: ItineraryDraftCaptureLocations;
  versionValues: ItineraryDraftCaptureVersionValues;
  protocolValues: ItineraryDraftCaptureProtocolValues;
  tourDailyType: "absent" | "null" | "string" | "object" | "other";
  requestHeaderPresent: boolean;
  piCategoryId: CaptureScalar;
}

export function asCaptureRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function parseCaptureRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "string") return asCaptureRecord(value);
  try {
    // JS would round 18-digit VBK version IDs before we project them.
    const idSafe = value.replace(
      /("(?:tourInfoId|previewTourInfoId|auditTourInfoId|draftTourInfoId|fromTourInfoId|tourInfoScoreId|tourDaily[A-Za-z]+Id)"\s*:\s*)(\d{16,})/g,
      '$1"$2"',
    );
    return asCaptureRecord(JSON.parse(idSafe));
  } catch { return undefined; }
}

function scalar(value: unknown): CaptureScalar {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null
    ? value
    : null;
}

interface LocatedRecord { location: CaptureRecordLocation; value: Record<string, unknown> }

function candidateRecords(value: unknown): LocatedRecord[] {
  const body = asCaptureRecord(value);
  if (!body) return [];
  const candidates: Array<[CaptureRecordLocation, Record<string, unknown> | undefined]> = [
    ["tourInfo", asCaptureRecord(body.tourInfo)],
    ["productTourInfo", asCaptureRecord(body.productTourInfo)],
    ["result", asCaptureRecord(body.result)],
    ["tourDaily", parseCaptureRecord(body.tourDaily)],
    ["body", body],
  ];
  return candidates.flatMap(([location, record]) => record ? [{ location, value: record }] : []);
}

function projectedField(records: LocatedRecord[], name: string): { value: CaptureScalar; locations: CaptureRecordLocation[]; values: LocatedScalar[] } {
  const matches = records.filter((record) => record.value[name] !== undefined);
  return {
    value: matches.length ? scalar(matches[0]!.value[name]) : null,
    locations: matches.map((record) => record.location),
    values: matches.map((record) => ({ location: record.location, value: scalar(record.value[name]) })),
  };
}

function firstGatherAirports(records: LocatedRecord[]): ItineraryDraftCaptureProtocolValues["firstGatherAirport"] {
  return records.flatMap(({ location, value }) => {
    const firstDay = Array.isArray(value.tourDailyDescriptions) ? asCaptureRecord(value.tourDailyDescriptions[0]) : undefined;
    const gather = Array.isArray(firstDay?.tourDailyInfos)
      ? firstDay.tourDailyInfos.map(asCaptureRecord).find((info) => {
        const activeType = asCaptureRecord(info?.activeType);
        return activeType?.key === 25 || activeType?.name === "集合";
      })
      : undefined;
    const packageGather = gather && Array.isArray(gather.tourDailyPackageGatherList)
      ? asCaptureRecord(gather.tourDailyPackageGatherList[0])
      : undefined;
    const airport = packageGather && Array.isArray(packageGather.airports) ? asCaptureRecord(packageGather.airports[0]) : undefined;
    return airport ? [{ location, code: scalar(airport.code), name: scalar(airport.name) }] : [];
  });
}

function hotelShapes(records: LocatedRecord[]): ItineraryDraftCaptureProtocolValues["hotelShapes"] {
  return records.map(({ location, value }) => {
    const days = Array.isArray(value.tourDailyDescriptions) ? value.tourDailyDescriptions.map(asCaptureRecord) : [];
    const infos = days.flatMap((day) => {
      const values = Array.isArray(day?.tourDailyInfos) ? day.tourDailyInfos
        : Array.isArray(day?.tourDailyInfoList) ? day.tourDailyInfoList : [];
      return values.map(asCaptureRecord).filter((info): info is Record<string, unknown> => Boolean(info));
    });
    const hotelInfos = infos.filter((info) => {
      const activeType = asCaptureRecord(info.activeType);
      return activeType?.key === 1 || activeType?.name === "酒店";
    });
    const slots = hotelInfos.flatMap((info) => [
      ...(Array.isArray(info.tourDailyHotels) ? info.tourDailyHotels : []),
      ...(Array.isArray(info.packageHotels) ? info.packageHotels : []),
    ].map(asCaptureRecord).filter((slot): slot is Record<string, unknown> => Boolean(slot)));
    return {
      location,
      hotelInfoCount: hotelInfos.length,
      tourDailyHotelsCount: hotelInfos.reduce((count, info) => count + (Array.isArray(info.tourDailyHotels) ? info.tourDailyHotels.length : 0), 0),
      packageHotelsCount: hotelInfos.reduce((count, info) => count + (Array.isArray(info.packageHotels) ? info.packageHotels.length : 0), 0),
      hotelIdPresent: slots.some((slot) => slot.hotelId !== undefined || asCaptureRecord(slot.hotel)?.hotelId !== undefined),
      gradePresent: slots.some((slot) => slot.grade !== undefined || asCaptureRecord(slot.hotel)?.grade !== undefined),
    };
  }).filter((shape) => shape.hotelInfoCount || shape.tourDailyHotelsCount || shape.packageHotelsCount);
}

function tourDailyType(value: unknown): ItineraryDraftCapturePayload["tourDailyType"] {
  if (value === undefined) return "absent";
  if (value === null) return "null";
  if (typeof value === "string") return "string";
  if (typeof value === "object") return "object";
  return "other";
}

/** Projects only whitelisted diagnostics from a request or response record. */
export function versionProjection(value: unknown): ItineraryDraftCapturePayload {
  const body = asCaptureRecord(value) ?? {};
  const records = candidateRecords(value);
  const saveType = projectedField(records, "saveType");
  const tourInfoId = projectedField(records, "tourInfoId");
  const draftTourInfoId = projectedField(records, "draftTourInfoId");
  const auditTourInfoId = projectedField(records, "auditTourInfoId");
  const previewTourInfoId = projectedField(records, "previewTourInfoId");
  const auditTourInfoStatus = projectedField(records, "auditTourInfoStatus");
  const draftTourInfoStatus = projectedField(records, "draftTourInfoStatus");
  const isModify = projectedField(records, "isModify");
  const isNew = projectedField(records, "isNew");
  const fromTourInfoId = projectedField(records, "fromTourInfoId");
  const auditStatusRecords = records.filter((record) => asCaptureRecord(record.value.auditStatus));
  const auditStatus = auditStatusRecords.length ? asCaptureRecord(auditStatusRecords[0]!.value.auditStatus) : undefined;
  return {
    saveType: saveType.value, tourInfoId: tourInfoId.value, draftTourInfoId: draftTourInfoId.value,
    auditTourInfoId: auditTourInfoId.value, previewTourInfoId: previewTourInfoId.value,
    auditTourInfoStatus: auditTourInfoStatus.value, draftTourInfoStatus: draftTourInfoStatus.value,
    auditStatusKey: scalar(auditStatus?.key), auditStatusValue: scalar(auditStatus?.value),
    locations: {
      saveType: saveType.locations, tourInfoId: tourInfoId.locations, draftTourInfoId: draftTourInfoId.locations,
      auditTourInfoId: auditTourInfoId.locations, previewTourInfoId: previewTourInfoId.locations,
      auditTourInfoStatus: auditTourInfoStatus.locations, draftTourInfoStatus: draftTourInfoStatus.locations,
      auditStatus: auditStatusRecords.map((record) => record.location),
    },
    versionValues: {
      tourInfoId: tourInfoId.values, draftTourInfoId: draftTourInfoId.values,
      auditTourInfoId: auditTourInfoId.values, previewTourInfoId: previewTourInfoId.values,
      auditTourInfoStatus: auditTourInfoStatus.values, draftTourInfoStatus: draftTourInfoStatus.values,
    },
    protocolValues: {
      isModify: isModify.values, isNew: isNew.values, fromTourInfoId: fromTourInfoId.values,
      firstGatherAirport: firstGatherAirports(records),
      hotelShapes: hotelShapes(records),
    },
    tourDailyType: tourDailyType(body.tourDaily), requestHeaderPresent: Boolean(asCaptureRecord(body.requestHeader)),
    piCategoryId: scalar(body.piCategoryId),
  };
}
