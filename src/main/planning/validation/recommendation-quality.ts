/**
 * 推荐理由具体性校验。
 *
 * 运营反馈三条推荐理由太空泛、不突出。这里给出两条硬性规则，问题文案
 * 写明第几条与原因，直接作为阶段重试的拒绝原因回传给模型：
 *   - 每条至少包含一个本行程真实景点名、城市名或数字；
 *   - 任意两条的字符二元组 Jaccard 相似度不得达到 0.6。
 */

const DUPLICATE_SIMILARITY = 0.6;

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown): string => typeof value === "string" ? value.trim() : "";
const compact = (value: string): string => value.replace(/[\s·・•]/gu, "");
const bigramSource = (value: string): string => compact(value).replace(/[，,、。；;：:！!？?\-—–]/gu, "");

function concreteNames(product: Record<string, unknown>): string[] {
  const names = new Set<string>();
  const add = (value: unknown) => {
    const raw = text(value);
    const name = compact(raw);
    if (name) names.add(name);
    // 「布达拉宫·红宫」这类组合名，各段（至少 2 字）单独提及也算具体。
    for (const part of raw.split(/[·・•]/u).map(compact)) if (part.length >= 2) names.add(part);
  };
  add(record(product.basicInfo).meetingCity);
  for (const day of Array.isArray(product.itinerary) ? product.itinerary.map(record) : []) {
    add(day.hotelCity);
    for (const spot of Array.isArray(day.spots) ? day.spots.map(record) : []) {
      add(spot.poiName);
      add(spot.name);
    }
  }
  return [...names];
}

function bigrams(value: string): Set<string> {
  const source = bigramSource(value);
  const grams = new Set<string>();
  for (let index = 0; index + 1 < source.length; index += 1) grams.add(source.slice(index, index + 2));
  return grams;
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const gram of left) if (right.has(gram)) shared += 1;
  return shared / (left.size + right.size - shared);
}

/** 取出 presentation.recommendations[].text；不是数组时返回 undefined。 */
export function presentationRecommendationTexts(presentation: unknown): string[] | undefined {
  const recommendations = record(presentation).recommendations;
  if (!Array.isArray(recommendations)) return undefined;
  return recommendations.map((entry) => text(record(entry).text));
}

export function recommendationQualityProblems(product: Record<string, unknown>, texts: string[]): string[] {
  const names = concreteNames(product);
  const problems: string[] = [];
  texts.forEach((value, index) => {
    const copy = compact(value);
    if (!/\d/u.test(copy) && !names.some((name) => copy.includes(name))) {
      problems.push(`第${index + 1}条缺少具体景点名或数字`);
    }
  });
  const grams = texts.map(bigrams);
  for (let left = 0; left < grams.length; left += 1) {
    for (let right = left + 1; right < grams.length; right += 1) {
      if (jaccard(grams[left]!, grams[right]!) >= DUPLICATE_SIMILARITY) {
        problems.push(`第${left + 1}条与第${right + 1}条内容重复`);
      }
    }
  }
  return problems;
}
