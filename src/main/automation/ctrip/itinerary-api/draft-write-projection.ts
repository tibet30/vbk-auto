export type DraftWriteProjection = {
  pickup: { code: string | null; name: string | null };
  hotelGrades: Array<{ key: string | null; name: string | null }>;
  hotelNodes: Array<{
    description: string | null;
    slots: Array<{ name: string | null; gradeKey: string | null; gradeName: string | null }>;
  }>;
  bridge85862: { key: string | null; name: string | null } | null;
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Whitelisted local write evidence: no itinerary text, tokens, or full request body. */
export function projectDraftWrite(value: unknown): DraftWriteProjection {
  const source = Array.isArray(value) ? value : record(value)?.tourDailyDescriptions;
  const days: Record<string, unknown>[] = Array.isArray(source)
    ? source.map(record).filter((day): day is Record<string, unknown> => Boolean(day))
    : [];
  const infos: Record<string, unknown>[] = days.flatMap((day) => Array.isArray(day.tourDailyInfos)
    ? day.tourDailyInfos.map(record).filter((info): info is Record<string, unknown> => Boolean(info))
    : []);
  const gather = infos.find((info) => record(info.activeType)?.key === 25);
  const packages: unknown[] = gather && Array.isArray(gather.tourDailyPackageGatherList) ? gather.tourDailyPackageGatherList : [];
  const airports = record(packages[0])?.airports;
  const airport = Array.isArray(airports) ? record(airports[0]) : undefined;
  const hotelNodes = infos.filter((info) => record(info.activeType)?.key === 1 || record(info.activeType)?.name === "酒店")
    .map((info) => {
      const slots = Array.isArray(info.tourDailyHotels) ? info.tourDailyHotels.map(record).filter((slot): slot is Record<string, unknown> => Boolean(slot)) : [];
      return {
        description: typeof info.description === "string" ? info.description : null,
        slots: slots.map((slot) => {
          const hotel = record(slot.hotel);
          const grade = record(hotel?.grade);
          return {
            name: typeof hotel?.hotelName === "string" ? hotel.hotelName : null,
            gradeKey: typeof grade?.key === "string" || typeof grade?.key === "number" ? String(grade.key) : null,
            gradeName: typeof grade?.name === "string" ? grade.name : null,
          };
        }),
      };
    });
  const hotelGrades = hotelNodes.flatMap((node) => node.slots)
    .filter((slot) => slot.gradeName !== null)
    .map((slot) => ({ key: slot.gradeKey, name: slot.gradeName }));
  const bridge = infos.flatMap((info) => Array.isArray(info.tourDailyPois) ? info.tourDailyPois.map(record) : [])
    .find((item) => String(record(item?.poi)?.poiId ?? "") === "85862");
  const suffix = record(bridge?.suffixName) ?? record(record(bridge?.poi)?.suffixName);
  return {
    pickup: { code: typeof airport?.code === "string" ? airport.code : null, name: typeof airport?.name === "string" ? airport.name : null }, hotelGrades, hotelNodes,
    bridge85862: suffix ? {
      key: typeof suffix.key === "string" || typeof suffix.key === "number" ? String(suffix.key) : null,
      name: typeof suffix.name === "string" ? suffix.name : null,
    } : null,
  };
}
