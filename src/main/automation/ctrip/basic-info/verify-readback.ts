type Json = Record<string, any>;

interface ExpectedBasicInfo {
  cityId: number;
  productLineId: number | null;
  code: string;
  phone: string;
  contactCardId: number;
  localTravelAgencyId: number;
  complaintContactId: number;
  bookingContactId: number;
  emergencyContactId: number;
  forChild: string;
}

/** 写入响应不等于业务完成。逐字段核验，错误直接记录实际差异供安全恢复。 */
export function assertBasicInfoReadback(base: Json, booking: Json, expected: ExpectedBasicInfo, subtitle?: string): void {
  const fields: Array<[string, unknown, unknown]> = [
    ["masterDepartureCityId", expected.cityId, Number(base.masterDepartureCityId)],
    ["destinationCityID", expected.cityId, Number(base.destinationCityID)],
    ["vendorProductCode", expected.code, String(base.vendorProductCode ?? "")],
    ["phone400", expected.phone, String(base.phone400 ?? "")],
    ["vendorBookingSeneschalContactId", expected.contactCardId, Number(booking.vendorBookingSeneschalContactId)],
    ["vendorComplainContactId", expected.complaintContactId, Number(booking.vendorComplainContactId)],
    ["vendorBookingContactId", expected.bookingContactId, Number(booking.vendorBookingContactId)],
    ["vendorBookingEmergencyContactId", expected.emergencyContactId, Number(booking.vendorBookingEmergencyContactId)],
    ["forChild", expected.forChild, String(booking.forChild)],
    ["localInfoID", expected.localTravelAgencyId, Number(booking.localInfoID
      ?? (Array.isArray(booking.localInfoIds) ? booking.localInfoIds[0] : 0))],
  ];
  if (expected.productLineId !== null) fields.push(["productLineID", expected.productLineId, Number(base.productLineID)]);
  if (subtitle !== undefined) fields.push(
    ["isAutoCalculateProductLevel", "F", base.isAutoCalculateProductLevel],
    ["subName", subtitle, base.subName],
  );
  const differences = fields.filter(([, wanted, actual]) => wanted !== actual);
  if (differences.length) throw new Error("VBK 基本信息保存后远端回读不一致："
    + differences.map(([name, wanted, actual]) => `${name}（期望 ${JSON.stringify(wanted)}，实际 ${JSON.stringify(actual)}）`).join("；"));
}
