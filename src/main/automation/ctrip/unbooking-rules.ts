/** 条款页签 3 的标准退订条款：只允许「行程当日」一行，旅行者与旅行社均收取总费用 100%。 */
export const SAME_DAY_PENALTY_RATE = 1;

type Rule = Record<string, unknown>;

function rules(value: unknown): Rule[] {
  return Array.isArray(value) ? value.filter((rule): rule is Rule => !!rule && typeof rule === "object") : [];
}

/** unBookingContentDto 的标准条款（非节假日）是否恰为「行程当日 100%」。 */
export function isSameDayOnlyFullPenalty(unBookingContentDto: unknown): boolean {
  const regions = rules((unBookingContentDto as Rule | undefined)?.regionUnbookingRules);
  const standard = regions
    .flatMap((region) => rules(region.unBookingRuleDtos))
    .filter((rule) => rule.isHoliday !== "T");
  if (standard.length !== 1) return false;
  const [rule] = standard;
  return Number(rule.minAdvanceDays) === 0 && Number(rule.maxAdvanceDays) === 0
    && Number(rule.lossValue) === SAME_DAY_PENALTY_RATE
    && Number(rule.travelAgencyLossValue) === SAME_DAY_PENALTY_RATE;
}
