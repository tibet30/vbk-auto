/**
 * 本机账号视图 Skill（只读）。
 *
 * 只回答"本机记录了什么"，不回答"现在是否登录"：
 * 实时登录状态由 VBK 页面抓取决定，必须由运营在设置页确认，模型不得凭本地
 * cookie 记录推断登录成功，更不得据此声称已能操作后台。
 */

import type { AgentSkill, AgentSkillAction } from "../../types.js";

/** 账号域的只读端口；由主进程装配，Skill 不直接读 cookie 文件或数据库。 */
export const ACCOUNT_READ_ACCOUNT = "account-read";

export interface AccountReadRecord {
  accountKey: string;
  accountName: string;
  /** 是否为当前活跃账号键（仅代表本机选中项）。 */
  active: boolean;
  providerId?: number;
  /** cookie 快照在本机的保存时间。 */
  savedAt?: string;
  servicePhone?: string;
  butlerName?: string;
}

export interface AccountReadPort {
  accounts(): AccountReadRecord[];
}

const DISCLAIMER = "以上是本机保存记录，不代表 VBK 当前页面的实时登录状态；实时状态请在设置页确认。";

function maskPhone(value: string | undefined): string {
  if (!value) return "未配置";
  const digits = value.replace(/\s+/gu, "");
  return digits.length <= 6 ? digits : `${digits.slice(0, 4)}****${digits.slice(-2)}`;
}

function describe(record: AccountReadRecord): string {
  return [
    `${record.accountName}（${record.accountKey}）${record.active ? "· 当前选中" : ""}`,
    `  providerId：${record.providerId ?? "未缓存"}`,
    `  保存时间：${record.savedAt ?? "未知"}`,
    `  400 电话：${maskPhone(record.servicePhone)}`,
    `  管家联系人：${record.butlerName ?? "未配置"}`,
  ].join("\n");
}

function resolveAccount(port: AccountReadPort, key: string | undefined): AccountReadRecord {
  const accounts = port.accounts();
  if (!accounts.length) throw new Error("本机还没有保存任何 VBK 登录账号，请先在设置页登录。");
  const wanted = key?.trim();
  if (!wanted) {
    const active = accounts.find((record) => record.active);
    if (!active) throw new Error("本机没有选中任何 VBK 账号，请指定 accountKey 或先在设置页登录。");
    return active;
  }
  const exact = accounts.find((record) => record.accountKey === wanted || record.accountName === wanted);
  if (exact) return exact;
  const prefixed = accounts.filter((record) => record.accountKey.startsWith(wanted));
  if (prefixed.length === 1) return prefixed[0];
  if (prefixed.length > 1) throw new Error(`账号前缀命中 ${prefixed.length} 个，请给出完整 accountKey。`);
  throw new Error(`本机没有这个账号记录：${wanted}`);
}

export function createAccountReadSkill(port: AccountReadPort): AgentSkill {
  const listAction: AgentSkillAction = {
    name: "account.list",
    kind: "read",
    label: "查询本机 VBK 账号",
    risk: "low",
    description: "列出本机保存的 VBK 登录账号、是否当前选中、providerId 缓存与账号固定信息是否配置。只读本地记录，不访问后台。",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async target() {
      return { action: "account.list", targetKey: "account:list", accountKey: ACCOUNT_READ_ACCOUNT, risk: "low" };
    },
    async execute() {
      const accounts = port.accounts();
      if (!accounts.length) {
        return {
          content: `本机还没有保存任何 VBK 登录账号。${DISCLAIMER}`,
          summary: "查询本机账号：0 个",
          result: "账号记录为空",
        };
      }
      const active = accounts.filter((record) => record.active).length;
      return {
        content: [
          `本机保存 ${accounts.length} 个 VBK 账号${active ? `（其中 ${active} 个当前选中）` : "（当前未选中）"}：`,
          ...accounts.map(describe),
          DISCLAIMER,
        ].join("\n"),
        summary: `查询本机账号：${accounts.length} 个`,
        result: `返回 ${accounts.length} 个账号记录`,
      };
    },
  };

  const statusAction: AgentSkillAction = {
    name: "account.status",
    kind: "read",
    label: "查询账号配置",
    risk: "low",
    description: "读取某个 VBK 账号在本机的 providerId 缓存与固定信息（400 电话、管家联系人）；省略 accountKey 时取当前选中账号。",
    parameters: {
      type: "object",
      properties: { accountKey: { type: "string", description: "账号键或唯一前缀，省略表示当前选中账号" } },
      additionalProperties: false,
    },
    async target(args) {
      return {
        action: "account.status",
        targetKey: `account:${typeof args.accountKey === "string" && args.accountKey.trim() ? args.accountKey.trim() : "active"}`,
        accountKey: ACCOUNT_READ_ACCOUNT,
        risk: "low",
      };
    },
    async execute(args) {
      const record = resolveAccount(port, typeof args.accountKey === "string" ? args.accountKey : undefined);
      return {
        content: [describe(record), DISCLAIMER].join("\n"),
        summary: `查询账号 ${record.accountName} 的本机配置`,
        result: `读取账号 ${record.accountKey}`,
      };
    },
  };

  return {
    id: "account-read",
    label: "本机账号",
    description: "本机 VBK 账号记录与账号固定信息的只读查询；不代表实时登录状态，也不能据此操作后台。",
    actions: [listAction, statusAction],
  };
}
