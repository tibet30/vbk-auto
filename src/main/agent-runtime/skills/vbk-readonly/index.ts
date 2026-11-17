/**
 * VBK 后台只读查询 Skill（第 5 步的只读部分）。
 *
 * 只回答"当前 VBK 会话是什么状态、这个账号下有哪些联系人卡片"，
 * 不做任何后台写入：写入必须走动作计划 → 授权 → 收据，那是另一条链路。
 *
 * 所有查询都经 `VbkReadPort`，由主进程用现有 VBK 适配器装配；
 * 默认读缓存/本地数据，只有显式要求时才会真正请求后台接口。
 */

import type { PoiSuggestDetailResult } from "../../../../shared/contracts.js";
import type { ProviderContactCard } from "../../../../shared/contracts-vbk-account.js";
import type { AgentSkill, AgentSkillAction, AgentSkillContext } from "../../types.js";

export const VBK_READ_ACCOUNT = "vbk-read";

export interface VbkStatusSnapshot {
  loggedIn: boolean;
  message: string;
  /** VBK 页面展示名。 */
  accountName?: string;
  /** VBK 登录账号（vbk_xxx）。 */
  loginAccount?: string;
  /** 本机已知账号键。 */
  accounts?: string[];
}

/** 只读端口：由主进程用现有 VBK 浏览器适配器装配。 */
export interface VbkReadPort {
  status(options?: { refresh?: boolean }): Promise<VbkStatusSnapshot>;
  /** 读当前账号下的联系人卡片；providerId 省略时由端口自行解析（当前活跃账号）。 */
  contacts(options: { providerId?: number; keyword?: string }): Promise<{
    providerId: number;
    cards: ProviderContactCard[];
  }>;
  /** 平台 POI 建议查询（只读）。 */
  searchPoi(keyword: string): Promise<PoiSuggestDetailResult>;
}

function describeStatus(snapshot: VbkStatusSnapshot): string {
  if (!snapshot.loggedIn) return `VBK 未登录：${snapshot.message}`;
  const lines = [
    `VBK 已登录：${snapshot.accountName ?? "账号名未知"}${snapshot.loginAccount ? `（${snapshot.loginAccount}）` : ""}`,
    snapshot.message ? `页面状态：${snapshot.message}` : "",
    snapshot.accounts?.length ? `本机已知账号：${snapshot.accounts.join("、")}` : "",
  ];
  return lines.filter(Boolean).join("\n");
}

function describeCards(providerId: number, cards: readonly ProviderContactCard[]): string {
  if (!cards.length) return `供应商 ${providerId} 下没有匹配的联系人卡片。`;
  const lines = cards.slice(0, 20).map((card) => `- ${card.displayName}（联系人卡 ${card.contactCardId}）`);
  const more = cards.length > lines.length ? `\n…另有 ${cards.length - lines.length} 个未展示` : "";
  return `供应商 ${providerId} 的联系人卡片（${cards.length} 个）：\n${lines.join("\n")}${more}`;
}

function optionalPositiveInteger(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error("providerId 必须是正整数。");
  return parsed;
}

function describePoi(keyword: string, detail: PoiSuggestDetailResult): string {
  const candidates = detail.candidates.slice(0, 10);
  if (!candidates.length) {
    return `平台没有返回「${keyword}」的 POI 候选（HTTP ${detail.httpStatus}，业务状态 ${String(detail.businessStatus)}）。`;
  }
  const lines = candidates.map((candidate) => {
    const place = [candidate.province, candidate.city, candidate.district].filter(Boolean).join("·");
    const suffix = [place, candidate.selectable ? "可选" : "不可选"].filter(Boolean).join("，");
    const id = candidate.poiId === null ? "无 id" : `id ${candidate.poiId}`;
    return `- ${candidate.poiName ?? "（无名称）"}（${id}${suffix ? `，${suffix}` : ""}）`;
  });
  const more = detail.candidates.length > lines.length ? `\n…另有 ${detail.candidates.length - lines.length} 个候选` : "";
  return `「${keyword}」的 POI 候选（共 ${detail.poiListCount} 个，展示 ${lines.length} 个）：\n${lines.join("\n")}${more}`;
}

export function createVbkReadSkill(port: VbkReadPort): AgentSkill {
  const statusAction: AgentSkillAction = {
    name: "vbk.status",
    kind: "read",
    label: "查询 VBK 登录状态",
    risk: "low",
    description: "读取当前 VBK 会话的登录状态与账号；refresh=true 会刷新后台页面后再判断（较慢）。",
    parameters: {
      type: "object",
      properties: { refresh: { type: "boolean", description: "是否强制刷新 VBK 页面后判断，默认读缓存" } },
      additionalProperties: false,
    },
    async target() {
      return { action: "vbk.status", targetKey: "vbk:status", accountKey: VBK_READ_ACCOUNT, risk: "low" };
    },
    async execute(args) {
      const refresh = args.refresh === true;
      // 读取失败必须抛出去：由执行器落成 failed 收据，而不是"收据成功、正文说失败"。
      const snapshot = await port.status({ refresh });
      return {
        content: describeStatus(snapshot),
        summary: snapshot.loggedIn ? "VBK 已登录" : "VBK 未登录",
        result: `loggedIn=${snapshot.loggedIn}`,
      };
    },
  };

  const contactsAction: AgentSkillAction = {
    name: "vbk.contacts",
    kind: "read",
    label: "查询 VBK 联系人卡片",
    risk: "low",
    description: "读取当前 VBK 账号（或指定供应商）下的管家联系人卡片；只读，不修改任何后台数据。",
    parameters: {
      type: "object",
      properties: {
        providerId: { type: "number", description: "供应商 id，省略时用当前活跃账号" },
        keyword: { type: "string", description: "按名称筛选" },
      },
      additionalProperties: false,
    },
    async target(args) {
      const providerId = optionalPositiveInteger(args.providerId);
      return {
        action: "vbk.contacts",
        targetKey: `vbk:contacts:${providerId ?? "active"}`,
        accountKey: VBK_READ_ACCOUNT,
        risk: "low",
      };
    },
    async execute(args, _context: AgentSkillContext) {
      const providerId = optionalPositiveInteger(args.providerId);
      const keyword = typeof args.keyword === "string" && args.keyword.trim() ? args.keyword.trim() : undefined;
      const result = await port.contacts({ ...(providerId ? { providerId } : {}), ...(keyword ? { keyword } : {}) });
      return {
        content: describeCards(result.providerId, result.cards),
        summary: `查询联系人卡片：${result.cards.length} 个`,
        result: `providerId=${result.providerId} cards=${result.cards.length}`,
      };
    },
  };

  const poiAction: AgentSkillAction = {
    name: "vbk.poi",
    kind: "read",
    label: "查询平台 POI 候选",
    risk: "low",
    description: "按关键词查询平台 POI 候选（景点/地标），返回名称、id、所在地与是否可选；只读。",
    parameters: {
      type: "object",
      properties: { keyword: { type: "string", description: "要查询的地点名称关键词" } },
      required: ["keyword"],
      additionalProperties: false,
    },
    async target(args) {
      const keyword = typeof args.keyword === "string" ? args.keyword.trim() : "";
      if (!keyword) throw new Error("缺少必填参数 keyword。");
      return { action: "vbk.poi", targetKey: `vbk:poi:${keyword}`, accountKey: VBK_READ_ACCOUNT, risk: "low" };
    },
    async execute(args) {
      const keyword = String(args.keyword).trim();
      const detail = await port.searchPoi(keyword);
      return {
        content: describePoi(keyword, detail),
        summary: `查询 POI「${keyword}」：${detail.candidates.length} 个候选`,
        result: `keyword=${keyword} candidates=${detail.candidates.length} httpStatus=${detail.httpStatus}`,
      };
    },
  };

  return {
    id: "vbk",
    label: "VBK 后台（只读）",
    description: "读取 VBK 会话状态、账号下的联系人卡片与平台 POI 候选；只读，不执行任何后台写入。",
    actions: [statusAction, contactsAction, poiAction],
  };
}
