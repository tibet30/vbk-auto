/**
 * 票型必须由明确的游览语义决定：
 *   - 真实草稿回读已确认「远观且不上桥」为 key=1「外观」；
 *   - 不能把它降级为「无需门票」，也不能保留收费景点的含票承诺。
 *
 * FREE_TICKET_SUFFIX：spot.ticketType.key=2（已免门票）→ key=11「无需门票」；
 * PAID_TICKET_INCLUDED_SUFFIX：默认 → key=13「含成人儿童首道门票」。
 */

import { isExteriorOnlyVisit } from "../visit-semantics.js";

const FREE_TICKET_SUFFIX = { key: 11, name: "无需门票" } as const;
const PAID_TICKET_INCLUDED_SUFFIX = { key: 13, name: "含成人儿童首道门票" } as const;
const EXTERIOR_ONLY_SUFFIX = { key: 1, name: "外观" } as const;

export function attractionTicketSuffix(spot: { ticketType?: { key: number; name: string } | null; description?: string }) {
  if (isExteriorOnlyVisit(spot.description)) return { ...EXTERIOR_ONLY_SUFFIX };
  return spot.ticketType?.key === 2
    ? { ...FREE_TICKET_SUFFIX }
    : { ...PAID_TICKET_INCLUDED_SUFFIX };
}