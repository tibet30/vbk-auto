import type { ReadbackDayExpectation } from "./itinerary-types.js";

type Info = {
  activeType?: { key?: unknown; name?: unknown };
  description?: unknown;
  takeoffTime?: { key?: unknown; name?: unknown };
  tourDailyDinner?: { dinnerType?: { key?: unknown } };
};

export function checkServiceCards(dayLabel: string, expected: ReadbackDayExpectation, infos: Info[]): void {
  if (expected.transport) {
    const traffic = infos.filter(info => Number(info.activeType?.key) === 8);
    if (traffic.length !== 1) throw new Error(`${dayLabel} 交通卡片数量不一致：期望1，实际${traffic.length}`);
    const card = traffic[0]!;
    if (String(card.takeoffTime?.key) !== "D" || String(card.description ?? "").trim() !== expected.transport.description) {
      throw new Error(`${dayLabel} 交通卡片全天时间或补充说明不一致`);
    }
    const position = infos.indexOf(card);
    const breakfast = infos.findIndex(info => info.tourDailyDinner?.dinnerType?.key === "B");
    const gather = infos.findIndex(info => Number(info.activeType?.key) === 25);
    const expectedPosition = breakfast >= 0 ? breakfast + 1 : gather >= 0 ? gather + 1 : 0;
    if (position !== expectedPosition) throw new Error(`${dayLabel} 交通卡片必须紧接早餐；无早餐时置于接团后、游览前`);
  }
  const note = expected.hotels.find(hotel => hotel.selectionNote)?.selectionNote;
  if (note && infos.filter(info => Number(info.activeType?.key) === 1)
    .some(info => !String(info.description ?? "").includes(note))) {
    throw new Error(`${dayLabel} 酒店卡片缺少完整选房说明`);
  }
}
