import { GET_TOUR_INFO_LIST_URL, SOHEAD, postSoa, type ApiPage } from "./transport.js";
import { fetchTourDailyDetail } from "./steps.js";
import { projectDraftWrite, type DraftWriteProjection } from "./draft-write-projection.js";

type Scalar = string | number | boolean | null;
type VersionName = "formal" | "draft" | "audit" | "preview";

export interface ItineraryPoiDiagnostic {
  suffixName: { key: Scalar; name: Scalar } | null;
  description: string | null;
}

export interface ItineraryVersionDiagnostic {
  version: VersionName;
  tourInfoId: Scalar;
  linkedTourInfoIds: Record<string, Scalar>;
  statuses: {
    draftTourInfoStatus: Scalar;
    auditTourInfoStatus: Scalar;
    auditStatus: { key: Scalar; value: Scalar } | null;
  };
  detail: "available" | "notAvailable";
  /** Same minimal fields as the write guard; never raw daily content. */
  pickup: DraftWriteProjection["pickup"] | null;
  hotelGrades: DraftWriteProjection["hotelGrades"];
  poi85862: ItineraryPoiDiagnostic | null;
}

export interface ItineraryDraftDiagnostic {
  productId: string;
  versions: ItineraryVersionDiagnostic[];
}

function scalar(value: unknown): Scalar {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null
    ? value
    : null;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function presentId(value: Scalar): string | undefined {
  return value === null || value === "" || value === 0 || value === "0" ? undefined : String(value);
}

function linksOf(tourInfo: Record<string, unknown>): Record<string, Scalar> {
  return Object.fromEntries(Object.entries(tourInfo)
    .filter(([key]) => /(tour|resource|hotel).*Id$/i.test(key))
    .map(([key, value]) => [key, scalar(value)]));
}

function versionIds(tourInfo: Record<string, unknown>): Array<[VersionName, Scalar]> {
  return [
    ["formal", scalar(tourInfo.tourInfoId)],
    ["draft", scalar(tourInfo.draftTourInfoId)],
    ["audit", scalar(tourInfo.auditTourInfoId)],
    ["preview", scalar(tourInfo.previewTourInfoId)],
  ];
}

function statusesOf(tourInfo: Record<string, unknown>): ItineraryVersionDiagnostic["statuses"] {
  const auditStatus = asRecord(tourInfo.auditStatus);
  return {
    draftTourInfoStatus: scalar(tourInfo.draftTourInfoStatus),
    auditTourInfoStatus: scalar(tourInfo.auditTourInfoStatus),
    auditStatus: auditStatus ? { key: scalar(auditStatus.key), value: scalar(auditStatus.value) } : null,
  };
}

function poiDiagnostic(tourInfo: Record<string, unknown>): ItineraryPoiDiagnostic | null {
  const days = Array.isArray(tourInfo.tourDailyDescriptions) ? tourInfo.tourDailyDescriptions : [];
  for (const day of days) {
    const dayRecord = asRecord(day);
    const infos = dayRecord?.tourDailyInfoList ?? dayRecord?.tourDailyInfos;
    if (!Array.isArray(infos)) continue;
    for (const info of infos) {
      const record = asRecord(info);
      const pois = record?.tourDailyPois;
      if (!Array.isArray(pois)) continue;
      for (const poiEntry of pois) {
        const poi = asRecord(asRecord(poiEntry)?.poi);
        if (String(poi?.poiId ?? "") !== "85862") continue;
        const suffix = asRecord(asRecord(poiEntry)?.suffixName) ?? asRecord(poi?.suffixName);
        return {
          suffixName: suffix ? { key: scalar(suffix.key), name: scalar(suffix.name) } : null,
          description: typeof record?.description === "string" ? record.description : null,
        };
      }
    }
  }
  return null;
}

/** Read all explicitly linked itinerary versions without inferring server status enums. */
export async function readItineraryDraftDiagnostic(page: ApiPage, productId: string): Promise<ItineraryDraftDiagnostic> {
  const { payload } = await postSoa(page, GET_TOUR_INFO_LIST_URL, {
    contentType: "json", head: SOHEAD, productId: Number(productId) || productId,
  }, "VBK 行程草稿诊断关联读取");
  const tourInfo = asRecord(Array.isArray(payload.tourInfos) ? payload.tourInfos[0] : undefined);
  if (!tourInfo) return { productId, versions: [] };
  const linkedTourInfoIds = linksOf(tourInfo);
  const statuses = statusesOf(tourInfo);
  const seen = new Set<string>();
  const versions: ItineraryVersionDiagnostic[] = [];
  for (const [version, rawId] of versionIds(tourInfo)) {
    const id = presentId(rawId);
    if (!id || seen.has(`${version}:${id}`)) continue;
    seen.add(`${version}:${id}`);
    // Reuse the established protocol request shape, including its fixed departureDate for existing tour detail reads.
    const { tourInfo: detail } = await fetchTourDailyDetail(page, id);
    const writeProjection = detail ? projectDraftWrite(detail) : null;
    versions.push({
      version, tourInfoId: rawId, linkedTourInfoIds, statuses,
      detail: detail ? "available" : "notAvailable",
      pickup: writeProjection?.pickup ?? null,
      hotelGrades: writeProjection?.hotelGrades ?? [],
      poi85862: detail ? poiDiagnostic(detail) : null,
    });
  }
  return { productId, versions };
}
