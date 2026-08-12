export interface CommercialInventoryDefault {
  startDate: string;
  endDate: string;
  dailyQuota: number;
}

function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function lastDayOfMonth(year: number, monthIndex: number): number {
  return new Date(year, monthIndex + 1, 0).getDate();
}

function addOneCalendarYearClamped(date: Date): Date {
  const year = date.getFullYear() + 1;
  const month = date.getMonth();
  const day = Math.min(date.getDate(), lastDayOfMonth(year, month));
  return new Date(year, month, day);
}

export function defaultCommercialInventory(now = new Date()): CommercialInventoryDefault {
  return {
    startDate: formatLocalDate(now),
    endDate: formatLocalDate(addOneCalendarYearClamped(now)),
    dailyQuota: 30,
  };
}
