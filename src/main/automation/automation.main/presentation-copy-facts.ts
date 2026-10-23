/** Extract stable, safety-critical presentation facts before an AI copy rewrite. */
const benefitNames = "门票|接送|用车|早餐|早饭|午餐|晚餐|餐食|保险|早|餐";
const subjectPattern = /成人|儿童/gu;

function normalizedBenefit(value: string): string {
  if (value === "早饭" || value === "早") return "早餐";
  return value;
}

function normalizedRelation(value: string | undefined): string {
  if (!value) return "提及";
  if (value === "包含") return "含";
  if (value === "不包含" || value === "未包含" || value === "未含") return "不含";
  if (value.startsWith("未")) return `不${value.slice(1)}`;
  return value;
}

function nearbyBenefitFacts(subject: string, copy: string): string[] {
  const facts: string[] = [];
  const relation = new RegExp(`(不包含|未包含|不含|未含|不赠送|未赠送|不免费|未免费|不提供|未提供|不安排|未安排|包含|含|赠送|免费|提供|安排|自理)?(${benefitNames})(自理)?`, "gu");
  for (const match of copy.matchAll(relation)) {
    const kind = match[3] ? "自理" : normalizedRelation(match[1]);
    facts.push(`关系:${subject}:${kind}:${normalizedBenefit(match[2]!)}`);
  }
  const benefitThenNumber = new RegExp(String.raw`(${benefitNames})[^\d，,。；;\n]{0,8}(\d+(?:\.\d+)?)`, "gu");
  for (const match of copy.matchAll(benefitThenNumber)) {
    facts.push(`权益数值:${subject}:${normalizedBenefit(match[1]!)}:${match[2]}`);
  }
  const numberThenBenefit = new RegExp(String.raw`(\d+(?:\.\d+)?)[^，,。；;\n]{0,8}(${benefitNames})`, "gu");
  for (const match of copy.matchAll(numberThenBenefit)) {
    facts.push(`权益数值:${subject}:${normalizedBenefit(match[2]!)}:${match[1]}`);
  }
  return facts;
}

function subjectClauses(segment: string): Array<{ subject: string; copy: string }> {
  const matches = [...segment.matchAll(subjectPattern)];
  if (!matches.length) return [{ subject: "全体", copy: segment }];
  const clauses: Array<{ subject: string; copy: string }> = [];
  const prefix = segment.slice(0, matches[0]!.index).trim();
  if (prefix) clauses.push({ subject: "全体", copy: prefix });
  matches.forEach((match, index) => {
    const start = match.index! + match[0].length;
    const end = matches[index + 1]?.index ?? segment.length;
    clauses.push({ subject: match[0], copy: segment.slice(start, end) });
  });
  return clauses;
}

function relationFacts(value: string): string[] {
  const facts: string[] = [];
  for (const segment of value.split(/[，,。；;\n]/u)) {
    for (const { subject, copy } of subjectClauses(segment)) {
      if (subject !== "全体") facts.push(`主体:${subject}`);
      facts.push(...nearbyBenefitFacts(subject, copy));
      const entitlement = new RegExp(`(不包含|未包含|不含|未含|包含|含|不赠送|未赠送|赠送|不免费|未免费|免费)(${benefitNames})`, "gu");
      for (const match of copy.matchAll(entitlement)) {
        const relation = normalizedRelation(match[1]);
        facts.push(`权益:${subject}:${relation}:${normalizedBenefit(match[2]!)}`);
      }
      const selfPaidAfter = new RegExp(`(${benefitNames})自理`, "gu");
      for (const match of copy.matchAll(selfPaidAfter)) {
        facts.push(`权益:${subject}:自理:${normalizedBenefit(match[1]!)}`);
      }
      const selfPaidBefore = new RegExp(`自理(${benefitNames})`, "gu");
      for (const match of copy.matchAll(selfPaidBefore)) {
        facts.push(`权益:${subject}:自理:${normalizedBenefit(match[1]!)}`);
      }
      for (const match of copy.matchAll(/\d+(?:\.\d+)?/gu)) {
        facts.push(`数值:${subject}:${match[0]}`);
      }
    }
  }
  return facts;
}

/**
 * Facts that must remain semantically equivalent when only presentation wording changes.
 * The legacy lexical tokens protect unscoped facts; relation facts bind benefits to people
 * and retain a negative relation instead of treating it as the positive token it contains.
 */
export function protectedPresentationFacts(value: string): string[] {
  const scalar = value.match(/\d+(?:\.\d+)?|(?:含餐|含早|含午餐|含晚餐|赠送|免费|保险|保证|自理|一单一团|管家服务|线上管家)/g) ?? [];
  return [...scalar, ...relationFacts(value)]
    .map(token => token.replace(/\s+/g, ""))
    .sort();
}
