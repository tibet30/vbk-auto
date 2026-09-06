import type Database from "better-sqlite3";

export interface CachedCtripPoiAvailability {
  poiId: number;
  status: "available" | "suspended";
  openStatus: string;
  latelyOpenTime: string | null;
  verifiedAt: string;
}

export function getCachedCtripPoiAvailability(
  db: Database.Database,
  poiId: number,
): CachedCtripPoiAvailability | undefined {
  const row = db.prepare(`SELECT poi_id, status, open_status, lately_open_time, verified_at
    FROM ctrip_poi_availability_cache WHERE poi_id = ?`).get(poiId) as {
      poi_id: number;
      status: "available" | "suspended";
      open_status: string;
      lately_open_time: string | null;
      verified_at: string;
    } | undefined;
  if (!row) return undefined;
  return {
    poiId: row.poi_id,
    status: row.status,
    openStatus: row.open_status,
    latelyOpenTime: row.lately_open_time,
    verifiedAt: row.verified_at,
  };
}

export function saveCachedCtripPoiAvailability(
  db: Database.Database,
  entry: CachedCtripPoiAvailability,
): void {
  db.prepare(`INSERT INTO ctrip_poi_availability_cache
    (poi_id, status, open_status, lately_open_time, verified_at)
    VALUES (@poiId, @status, @openStatus, @latelyOpenTime, @verifiedAt)
    ON CONFLICT(poi_id) DO UPDATE SET
      status = excluded.status,
      open_status = excluded.open_status,
      lately_open_time = excluded.lately_open_time,
      verified_at = excluded.verified_at`).run(entry);
}
