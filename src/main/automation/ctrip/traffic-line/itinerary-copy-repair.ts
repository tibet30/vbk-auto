/**
 * 交通子产品行程文案被平台以「非法关键词」驳回时的自动修复。
 *
 * VBK 在子产品行程校验（`校验子产品行程交通` saveType=8）、保存校验
 * （`保存子产品行程交通` saveType=3）与线路匹配审核前校验
 * （`线路匹配审核前行程校验` saveType=3）都会判定行程文案非法关键词。
 * 这些校验都发生在远端写入之前，因此可以就地把命中的自由文案改好再重试。
 *
 * 只改写 VBK 行程详情里的自由文案字段（天标题 / 天补充说明 / 卡片描述 /
 * 温馨提示 / 特别赠送）；景点、酒店、交通实体身份与结构字段一律不碰。
 * 已经派发过远端写入的失败仍按原有失败语义上抛，不放宽边界。
 */
import type { AiResponse } from "../../../../shared/contracts.js";
import type { ItineraryCopyRewriter } from "../../../../shared/itinerary-copy-rewrite.js";
import { extractSensitiveWords } from "../../../../shared/sensitive-words.js";
import { buildVbkCopyPolicyPrompt, findVbkCopyBadCase } from "../../../planning/vbk-copy-policy.js";

export const TRAFFIC_ITINERARY_COPY_REPAIR_LIMIT = 2;

const DAY_KEYS = ["dailyDescription", "subDesc"] as const;
const INFO_KEYS = ["description", "warmTips", "specialGift"] as const;

const DAY_PATH = /^\/tourDailyDescriptions\/(\d+)\/(dailyDescription|subDesc)$/;
const INFO_PATH = /^\/tourDailyDescriptions\/(\d+)\/tourDailyInfos\/(\d+)\/(description|warmTips|specialGift)$/;

const REJECTION_LABELS = /(?:校验|保存)子产品行程交通失败（Ack=[^）]*）|线路匹配审核前行程校验失败（Ack=[^）]*）/;

export interface TrafficCopyTarget {
  path: string;
  value: string;
}

export interface TrafficLineCopyRepair {
  rewrite: ItineraryCopyRewriter;
  onRepaired?: (info: { words: string[]; paths: string[]; detail: string }) => void;
}

type Detail = Record<string, any>;

/** 平台在写前校验阶段以非法关键词驳回。 */
export function isTrafficItineraryKeywordRejection(message: unknown): boolean {
  return typeof message === "string" && REJECTION_LABELS.test(message);
}

function hits(value: unknown, words: readonly string[]): boolean {
  return typeof value === "string" && words.some((word) => value.includes(word));
}

/** 只返回允许自动改写的自由文案字段。 */
export function findTrafficDetailCopyHits(detail: Detail | undefined, words: readonly string[]): TrafficCopyTarget[] {
  const terms = words.map((word) => String(word ?? "").trim()).filter(Boolean);
  const days = Array.isArray(detail?.tourDailyDescriptions) ? detail!.tourDailyDescriptions : [];
  if (!terms.length) return [];
  const targets: TrafficCopyTarget[] = [];
  days.forEach((day: Detail | undefined, dayIndex: number) => {
    for (const key of DAY_KEYS) {
      if (hits(day?.[key], terms)) targets.push({ path: `/tourDailyDescriptions/${dayIndex}/${key}`, value: String(day![key]) });
    }
    const infos = Array.isArray(day?.tourDailyInfos) ? day!.tourDailyInfos : [];
    infos.forEach((info: Detail | undefined, infoIndex: number) => {
      for (const key of INFO_KEYS) {
        if (hits(info?.[key], terms)) {
          targets.push({ path: `/tourDailyDescriptions/${dayIndex}/tourDailyInfos/${infoIndex}/${key}`, value: String(info![key]) });
        }
      }
    });
  });
  return targets;
}

export function readTrafficDetailCopy(detail: Detail | undefined, path: string): string | undefined {
  const day = DAY_PATH.exec(path);
  if (day) return detail?.tourDailyDescriptions?.[Number(day[1])]?.[day[2]];
  const info = INFO_PATH.exec(path);
  if (info) return detail?.tourDailyDescriptions?.[Number(info[1])]?.tourDailyInfos?.[Number(info[2])]?.[info[3]];
  return undefined;
}

function writeTrafficDetailCopy(detail: Detail, path: string, value: string): void {
  const day = DAY_PATH.exec(path);
  if (day) {
    const target = detail.tourDailyDescriptions?.[Number(day[1])];
    if (!target) throw new Error(`AI 重写目标不存在：${path}`);
    target[day[2]!] = value;
    return;
  }
  const info = INFO_PATH.exec(path);
  if (info) {
    const target = detail.tourDailyDescriptions?.[Number(info[1])]?.tourDailyInfos?.[Number(info[2])];
    if (!target) throw new Error(`AI 重写目标不存在：${path}`);
    target[info[3]!] = value;
    return;
  }
  throw new Error(`AI 重写目标不是允许的行程文案路径：${path}`);
}

/** 只接受命中路径的 replace，并逐项校验改写结果后整体提交。 */
export function applyTrafficDetailCopyRewrite(detail: Detail, response: AiResponse, words: readonly string[]): string[] {
  const targets = findTrafficDetailCopyHits(detail, words);
  if (!targets.length) throw new Error(`平台驳回子产品行程文案（${words.join("、")}），但未在行程详情中定位命中字段。`);
  const allowed = new Set(targets.map((target) => target.path));
  const operations = (response.patch ?? []).filter((operation) => operation.path.startsWith("/tourDailyDescriptions/"));
  if (!operations.length || operations.some((operation) => operation.op !== "replace"
    || !allowed.has(operation.path) || typeof operation.value !== "string")) {
    throw new Error("AI 子产品行程文案修复只能 replace 命中的文案字段。");
  }
  const next = structuredClone(detail) as Detail;
  for (const operation of operations) writeTrafficDetailCopy(next, operation.path, operation.value as string);
  for (const target of targets) {
    const value = readTrafficDetailCopy(next, target.path);
    if (typeof value !== "string" || !value.trim()) throw new Error(`AI 重写后子产品行程文案为空：${target.path}`);
    if (value.trim() === target.value.trim()) throw new Error(`AI 未重写命中的子产品行程文案字段：${target.path}`);
    const remaining = words.find((word) => word && value.includes(word));
    if (remaining) throw new Error(`AI 重写后仍包含平台非法关键词：${remaining}`);
    const policyHit = findVbkCopyBadCase(value, target.path);
    if (policyHit) throw new Error(`AI 重写后仍命中文案黑名单：${policyHit.term}`);
  }
  Object.assign(detail, next);
  return targets.map((target) => target.path);
}

function rewriteMessage(words: readonly string[], targets: readonly TrafficCopyTarget[]): string {
  return [
    `VBK 子产品行程校验以非法关键词驳回：${words.join("、")}。`,
    `仅重写命中的子产品行程文案字段：${targets.map((target) => target.path).join("、")}。`,
    "保持行程天数、交通卡片、景点与酒店实体、顺序与服务时间不变，不得再次出现上述词语。",
    buildVbkCopyPolicyPrompt(),
    `只返回对上述路径的 RFC6902 replace；例如 {"op":"replace","path":"${targets[0]!.path}","value":"不含非法词的新文案"}。不得返回完整行程或任何其他路径。`,
  ].join("\n");
}

/**
 * 执行子产品行程校验 / 保存；平台在写前校验阶段以非法关键词驳回时，
 * 就地把命中文案改好再重试。`execute` 必须在第一次真实远端写入前调用 markWrite。
 */
export async function runTrafficItineraryCopyRepair<T>(args: {
  detail: Detail;
  execute: (markWrite: () => void) => Promise<T>;
  repair?: TrafficLineCopyRepair;
  maxRepairs?: number;
}): Promise<T> {
  const maxRepairs = args.maxRepairs ?? TRAFFIC_ITINERARY_COPY_REPAIR_LIMIT;
  for (let round = 0; ; round += 1) {
    let wrote = false;
    try {
      return await args.execute(() => { wrote = true; });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!isTrafficItineraryKeywordRejection(message) || wrote) throw error;
      const words = extractSensitiveWords(message);
      if (!words.length) throw error;
      if (round >= maxRepairs) throw error;
      const targets = findTrafficDetailCopyHits(args.detail, words);
      if (!targets.length) throw new Error(`${message}；子产品行程详情里没有可自动改写的命中文案字段。`);
      if (!args.repair) throw new Error(`${message}；当前未配置行程文案改写器，无法自动修复。`);
      const response = await args.repair.rewrite({
        message: rewriteMessage(words, targets), product: structuredClone(args.detail) as Record<string, unknown>, targets,
      });
      const paths = applyTrafficDetailCopyRewrite(args.detail, response, words);
      args.repair.onRepaired?.({ words, paths, detail: message });
    }
  }
}
