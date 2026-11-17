/**
 * VBK 后台写入 Skill（第 5 步）。
 *
 * 决策 A 的门禁在这里落地：**产品数据的写入必须先通过该产品自身的程序检查与运营确认**，
 * 通用智能体的 `once`/`thread` 授权只算"执行许可"，不构成产品确认。
 * 本技能只接受产品域写入；非产品域动作后续按同一套准入（preview + reconcile + 账号级串行）扩展。
 */

import type { AgentSkill, AgentSkillAction } from "../../types.js";

export interface VbkWriteGateResult {
  allowed: boolean;
  /** 拒绝原因（allowed=false 时必填）。 */
  reason?: string;
  /** 写入应串行到的后台账号键。 */
  accountKey?: string;
  /** VBK 侧产品 id。 */
  vbkProductId?: string;
  /** 运营确认凭据（unlock 记录的 approvalId）。 */
  confirmationId?: string;
}

export interface VbkProductBasicInfo {
  title: string;
  meetingCity: string;
  days: number;
  nights: number;
  servicePhone?: string;
  butlerName?: string;
}

export interface VbkWritePort {
  /** 产品门禁：程序检查 + 运营确认都要通过，才允许写入。 */
  gate(productId: string): Promise<VbkWriteGateResult>;
  /** 将要写入的基本信息（用于审批卡预览）。 */
  describeBasicInfo(productId: string): Promise<VbkProductBasicInfo>;
  /** 把本地产品的基本信息写入 VBK。 */
  writeBasicInfo(productId: string): Promise<{ result: string }>;
  /** 回读 VBK 侧基本信息，用于执行后核对。 */
  readBasicInfo(productId: string): Promise<{ title?: string; meetingCity?: string }>;
}

function requireProductId(args: Record<string, unknown>): string {
  const value = args.productId;
  if (typeof value !== "string" || !value.trim()) throw new Error("缺少必填参数 productId（本地产品 id）。");
  return value.trim();
}

function describeBasicInfo(info: VbkProductBasicInfo): string {
  return [
    `标题：${info.title}`,
    `集合城市：${info.meetingCity}`,
    `天数：${info.days} 天 ${info.nights} 晚`,
    `400 电话：${info.servicePhone ?? "未配置"}`,
    `管家联系人：${info.butlerName ?? "未配置"}`,
  ].join("\n");
}

export function createVbkWriteSkill(port: VbkWritePort): AgentSkill {
  const basicInfoAction: AgentSkillAction = {
    name: "vbk.product.basicInfo",
    kind: "write",
    label: "写入产品基本信息",
    risk: "high",
    description:
      "把本地产品的基本信息（标题/集合城市/天数/400 电话/管家联系人）写入 VBK。"
      + "只允许对已通过程序检查且已完成运营确认的产品执行。",
    parameters: {
      type: "object",
      properties: { productId: { type: "string", description: "本地产品 id" } },
      required: ["productId"],
      additionalProperties: false,
    },
    async target(args) {
      const productId = requireProductId(args);
      const gate = await port.gate(productId);
      if (!gate.allowed) {
        throw new Error(`产品门禁未通过，拒绝写入：${gate.reason ?? "原因未知"}`);
      }
      if (!gate.accountKey || !gate.vbkProductId) {
        throw new Error("产品门禁通过但缺少后台账号或 VBK 产品 id，拒绝写入。");
      }
      return {
        action: "vbk.product.basicInfo",
        targetKey: `vbk:product:${gate.vbkProductId}`,
        accountKey: gate.accountKey,
        risk: "high",
      };
    },
    async preview(args) {
      const productId = requireProductId(args);
      const info = await port.describeBasicInfo(productId);
      const gate = await port.gate(productId);
      return {
        summary: `写入 VBK 产品基本信息（VBK 产品 id ${gate.vbkProductId ?? "未知"}，确认凭据 ${gate.confirmationId ?? "无"}）`,
        diff: describeBasicInfo(info),
      };
    },
    async execute(args) {
      const productId = requireProductId(args);
      // 前置状态：写入前先回读 VBK 当前值，写进收据的 before，便于事后对照。
      const before = await port.readBasicInfo(productId).catch(() => ({}) as { title?: string; meetingCity?: string });
      const beforeText = before.title
        ? `写入前 VBK 标题：${before.title}${before.meetingCity ? `（${before.meetingCity}）` : ""}`
        : "写入前 VBK 未读到当前标题";
      const written = await port.writeBasicInfo(productId);
      return {
        content: `已写入 VBK 产品基本信息：${written.result}`,
        summary: written.result.slice(0, 80),
        before: beforeText,
        result: written.result.slice(0, 500),
      };
    },
    async reconcile(args) {
      const productId = requireProductId(args);
      const local = await port.describeBasicInfo(productId);
      const remote = await port.readBasicInfo(productId);
      const landed = Boolean(remote.title) && remote.title === local.title;
      return {
        landed,
        detail: landed
          ? `回读标题一致：${remote.title}`
          : `回读不一致：本地「${local.title}」，VBK「${remote.title ?? "未读到"}」`,
      };
    },
  };

  return {
    id: "vbk-write",
    label: "VBK 后台（写入）",
    description: "向 VBK 写入已通过程序检查与运营确认的产品数据；每次写入都要授权并留下收据。",
    actions: [basicInfoAction],
  };
}
