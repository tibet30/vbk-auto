import { outsidePoiNames, trustedPresentationPoiNames } from "../../planning/vbk-copy-identity.js";
import { repairVbkCopyPolicyValue } from "../../planning/vbk-copy-policy.js";
import { applySensitivePresentationRewrite, type PresentationCopyPath } from "./presentation-copy-candidate.js";
import { cleanPlatformHotelCopy } from "../../../shared/platform-hotel-copy.js";
import { usesPlatformHotelRules } from "../../../shared/platform-hotel-rules.js";

type Product = Record<string, any> & { presentation?: Record<string, any> };

/** 只逆转旧规则对当前已确认实体的精确误改，不使用模糊地名推测。 */
function restoreLegacyNames(text: string, names: string[]): string {
  const aliases = new Map<string, Set<string>>();
  for (const name of names) {
    const alias = repairVbkCopyPolicyValue(name, "value.presentation.features", []) as string;
    if (alias === name || alias.length < 4 || names.includes(alias)) continue;
    const originals = aliases.get(alias) ?? new Set<string>();
    originals.add(name);
    aliases.set(alias, originals);
  }
  if (!aliases.size) return text;
  const escaped = [...aliases.keys()].sort((a, b) => b.length - a.length)
    .map(value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = new RegExp(escaped.join("|"), "g");
  return outsidePoiNames(text, names, copy => copy.replace(pattern, alias => {
    const originals = [...aliases.get(alias)!];
    if (originals.length !== 1) throw new Error(`旧文案地点「${alias}」无法唯一对应当前 POI，必须返回规划核查。`);
    return originals[0]!;
  }));
}

/** 已知本地规则在远端写入前一次性修复，仍通过同一候选门禁。 */
export function repairLocalPresentationCopy(product: Product): PresentationCopyPath[] {
  if (!product.presentation) return [];
  const presentation = structuredClone(product.presentation);
  const identityBaseline = structuredClone(product.presentation);
  const names = trustedPresentationPoiNames(product);
  // 平台酒店规则产品：已存图文可能带着旧版钻级折叠留下的病句，录入前一并修正。
  const hotelCopy = usesPlatformHotelRules(product)
    ? (value: string) => outsidePoiNames(value, names, copy => cleanPlatformHotelCopy(copy) as string)
    : (value: string) => value;
  const paths: PresentationCopyPath[] = [];
  const repair = (value: unknown, path: PresentationCopyPath, setRestored: (value: string) => void): unknown => {
    if (typeof value !== "string") return value;
    const restored = restoreLegacyNames(value, names);
    setRestored(restored);
    const next = hotelCopy(repairVbkCopyPolicyValue(restored, `value.presentation.${path}`, names) as string);
    if (next !== value) paths.push(path);
    return next;
  };
  presentation.recommendation = repair(presentation.recommendation, "recommendation", value => { identityBaseline.recommendation = value; });
  presentation.features = repair(presentation.features, "features", value => { identityBaseline.features = value; });
  if (Array.isArray(presentation.recommendations)) {
    presentation.recommendations.forEach((item: any, index: number) => {
      item.text = repair(item.text, `recommendations.${index}.text`, value => { identityBaseline.recommendations[index].text = value; });
    });
  }
  if (paths.length) {
    // 基线只接受上面唯一映射证明的名称校正；AI 入口仍严格保持引用集合。
    const validated = { ...product, presentation: identityBaseline };
    applySensitivePresentationRewrite(validated, {
      reply: "已按本地文案规则修复", questions: [], researchTasks: [],
      patch: [{ op: "replace", path: "/presentation", value: presentation }],
    }, paths, []);
    product.presentation = validated.presentation;
  }
  return paths;
}
