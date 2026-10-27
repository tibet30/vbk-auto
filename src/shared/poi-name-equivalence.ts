/**
 * 诊断用的「候选是否可能与原景点同名」判断。
 *
 * 与 `isCompatiblePoiIdentity` 的分工：
 *   - 后者只做否决（排除已知的上下级、独立冰川、不同湖），任何未命中否决的
 *     名字都会被当成可比较候选，不能回答「平台到底有没有同名地点」；
 *   - 本函数只用于生成给运营看的失败原因：一个同名候选都没有时，不能再把
 *     失败说成「地域不一致」，否则会把运营引去修改当天城市，而真正的问题是
 *     目录里没有这个地点。
 *
 * 判定保持保守：去注记后完全相等、已知别名、原路线证据别名、冰川/山峰/景区
 * 类别尾缀等价、包含关系，或至少 4 个汉字的公共片段。不参与自动选点。
 */
import { isKnownPoiNameAlias } from "./poi-name-aliases.js";
import { isOriginalRoutePoiAlias } from "./poi-original-route-identity.js";

const compact = (value: string) => value.replace(/[\s\p{Cf}]+/gu, "").replace(/[（）()]/gu, "").trim();
const CATEGORY_SUFFIX = /(?:山体冰川遗迹|冰川遗迹|冰川群|冰川|雪山|旅游景区|风景名胜区|风景区|景区|地质公园)$/u;
const GENERIC_PLACE_NAME = /^(?:大草原|草原|古村|古镇|古城|村寨|景区|风景区|冰川|雪山|沙漠|沙丘|湿地|湖泊|湖|山|峰|寺|庙|宫|村|镇|城|街|公园|广场)$/u;

function identityCore(value: string): string {
  return compact(value).replace(/^远眺/u, "").replace(/措$/u, "错").replace(CATEGORY_SUFFIX, "");
}

export function plausiblyEquivalentPoiName(left: unknown, right: unknown): boolean {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const a = compact(left);
  const b = compact(right);
  if (!a || !b) return false;
  if (a === b || isKnownPoiNameAlias(a, b) || isOriginalRoutePoiAlias(a, b)) return true;
  // 「希夏邦马峰冰川群」与「希夏邦马峰」在去类别尾缀后同名，但仍由身份门禁
  // 决定是否可绑定；这里只判断“平台确实有这个地点”。
  const coreA = identityCore(a);
  const coreB = identityCore(b);
  if (coreA.length >= 4 && coreA === coreB) return true;
  // 带地貌类别尾缀的名称（冰川/雪山/景区…）只看去尾缀后的核心名。否则
  // 「库拉岗日冰川」与「廓琼岗日冰川」仅共享「岗日冰川」就会误判为同名。
  if (CATEGORY_SUFFIX.test(a) || CATEGORY_SUFFIX.test(b)) return false;
  if (a.includes(b) || b.includes(a)) {
    // 目录里存在「大草原」「古村」这类通用词条，包含它们不等于同名地点。
    const shorter = a.length <= b.length ? a : b;
    return !GENERIC_PLACE_NAME.test(shorter);
  }
  return commonSubstringLength(a, b) >= 4;
}

/** 至少 4 个连续汉字的公共片段，避免把「巴松村 / 巴松措」这类短前缀误判为同名。 */
function commonSubstringLength(a: string, b: string): number {
  let best = 0;
  let previous = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    const current = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j += 1) {
      if (a[i - 1] === b[j - 1]) {
        current[j] = previous[j - 1]! + 1;
        if (current[j]! > best) best = current[j]!;
      }
    }
    previous = current;
  }
  return best;
}
