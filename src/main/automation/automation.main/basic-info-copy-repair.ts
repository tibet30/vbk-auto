/**
 * 基本信息文案被平台以「非法关键词」驳回时的自动修复。
 *
 * VBK 保存基本信息（saveProductBaseInfo）时会校验「操作说明」和「副标题」中的
 * 非法关键词，并在 Ack=Failure 的详情里点名字段与词（例如
 * `300019:操作说明存在非法关键词：冈仁波齐`）。平台明确要求「更换或删除」，
 * 因此这里按平台点名的词做确定性清理后重试，不猜测、不联网、不改其他字段。
 *
 * 只作用于 `basicInfo.operationNotes` / `basicInfo.subtitle` 两个自由文案字段；
 * 名称、城市、编号、景区 ID 等其他字段一律不碰。清理后字段为空或命中词不在
 * 可清理字段内时如实上抛，不伪造成功。
 */
import { extractSensitiveWords } from "../../../shared/sensitive-words.js";
import { stripBasicInfoIllegalKeywords } from "../ctrip/basic-info/name-keywords.js";

export const BASIC_INFO_COPY_REPAIR_LIMIT = 3;

/** 平台点名的字段标签 → 本地 basicInfo 文案字段。 */
const FIELD_LABELS: Array<{ label: string; key: "operationNotes" | "subtitle" }> = [
  { label: "操作说明", key: "operationNotes" },
  { label: "副标题", key: "subtitle" },
];

export interface BasicInfoCopyRejection {
  words: string[];
  /** 平台点名的字段标签；未点名时为空数组，此时按词实际出现的字段清理。 */
  labels: string[];
}

const FIELD_SEGMENT = /(操作说明|副标题)\s*(?:存在)?\s*非法关键词[：:]\s*([^；;。\n]+)/g;

/** 只接受「VBK 基本信息保存失败（Ack=Failure）」且带非法关键词的消息。 */
export function parseBasicInfoCopyRejection(message: unknown): BasicInfoCopyRejection | undefined {
  // 平台以 Ack=Failure 驳回；Ack 字段缺失或 Success 但带 Errors 时同样按保存失败处理。
  if (typeof message !== "string" || !/基本信息保存失败（Ack=[^）]*）/.test(message)) return undefined;
  const segments = [...message.matchAll(FIELD_SEGMENT)];
  const labels: string[] = [];
  const words: string[] = [];
  for (const segment of segments) {
    const label = segment[1]!;
    const hit = extractSensitiveWords(segment[0]);
    if (!hit.length) continue;
    if (!labels.includes(label)) labels.push(label);
    words.push(...hit);
  }
  const unique = [...new Set(words)];
  if (unique.length) return { words: unique, labels };
  const fallback = extractSensitiveWords(message);
  return fallback.length ? { words: fallback, labels: [] } : undefined;
}

/**
 * 按平台点名的词清理本地文案。只清理真正包含命中词的字段；
 * 点名了字段时优先只清理该字段，其他字段仅在未点名时才参与。
 */
export function repairBasicInfoCopy(
  product: Record<string, any>,
  rejection: BasicInfoCopyRejection,
): { changed: string[]; unresolved: string[] } {
  const basic = product?.basicInfo as Record<string, any> | undefined;
  if (!basic || typeof basic !== "object") return { changed: [], unresolved: [] };
  const words = rejection.words.map((word) => String(word ?? "").trim()).filter(Boolean);
  if (!words.length) return { changed: [], unresolved: [] };
  const named = FIELD_LABELS.filter((field) => rejection.labels.includes(field.label));
  const targets = named.length ? named : FIELD_LABELS;

  const changed: string[] = [];
  const unresolved: string[] = [];
  for (const field of targets) {
    const current = typeof basic[field.key] === "string" ? basic[field.key] : "";
    if (!current) continue;
    const hit = words.filter((word) => current.includes(word));
    if (!hit.length) continue;
    const next = stripBasicInfoIllegalKeywords(current, hit);
    if (!next) {
      unresolved.push(`${field.label}只包含平台禁止的关键词`);
      continue;
    }
    if (next === current) continue;
    basic[field.key] = next;
    changed.push(`${field.label}删除「${hit.join("、")}」`);
  }
  return { changed, unresolved };
}

export interface BasicInfoCopyRepairArgs<T> {
  product: Record<string, any>;
  save: () => Promise<T>;
  /** 清理后的产品落库（只改基本信息的自由文案）。 */
  persist: () => void;
  log: (message: string, level?: "info" | "warning" | "error") => void;
  /** 平台此前在基本信息里拒绝过的词，提交前先确定性清理。 */
  knownRejectedWords?: readonly string[];
  onLearned?: (words: readonly string[], labels: readonly string[], detail: string) => void;
  maxRounds?: number;
}

/**
 * 保存基本信息；平台以非法关键词驳回时，按平台点名的词清理本地文案后重试。
 * 预算有限，用尽或无法定位命中字段时如实上抛平台错误。
 */
export async function runBasicInfoSaveWithCopyRepair<T>(args: BasicInfoCopyRepairArgs<T>): Promise<T> {
  const maxRounds = args.maxRounds ?? BASIC_INFO_COPY_REPAIR_LIMIT;
  const originalBasicInfo = structuredClone(args.product.basicInfo);
  let repaired = false;
  let remotelyAccepted = false;
  const known = (args.knownRejectedWords ?? []).map((word) => String(word ?? "").trim()).filter(Boolean);
  if (known.length) {
    const preemptive = repairBasicInfoCopy(args.product, { words: known, labels: [] });
    if (preemptive.changed.length) {
      repaired = true;
      args.log(`基本信息文案命中平台此前拒绝的词，已预先清理：${preemptive.changed.join("；")}`, "warning");
    }
  }
  try {
    for (let round = 0; ; round += 1) {
      try {
        const result = await args.save();
        remotelyAccepted = true;
        if (repaired) args.persist();
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const rejection = parseBasicInfoCopyRejection(message);
        if (!rejection) throw error;
        if (round >= maxRounds) {
          args.log(`基本信息文案自动清理已使用 ${round}/${maxRounds} 轮仍未通过平台校验：${message}`, "warning");
          throw error;
        }
        const { changed, unresolved } = repairBasicInfoCopy(args.product, rejection);
        if (!changed.length) {
          throw new Error(`${message}；命中词不在可自动清理的基本信息文案字段内${unresolved.length ? `（${unresolved.join("；")}）` : ""}。`);
        }
        repaired = true;
        args.onLearned?.(rejection.words, rejection.labels, message);
        args.log(`平台驳回基本信息文案「${rejection.words.join("、")}」，已清理后重试保存：${changed.join("；")}`, "warning");
      }
    }
  } finally {
    if (repaired && !remotelyAccepted) args.product.basicInfo = originalBasicInfo;
  }
}
