/**
 * VBK 写入端口的真实装配。
 *
 * 门禁（决策 A）：产品必须①本地存在且已回填 VBK 产品 id、②程序检查通过（readiness.ready）、
 * ③已完成运营确认（itinerary review 解锁状态 verified 且有 approvalId）。
 * 三者缺一就拒绝写入，并在拒绝原因里说清楚缺什么。
 */

import { ensureBasicInfoApi, getProductBaseInfoApi } from "../automation/ctrip/basic-info/api.js";
import { getVbkRequestPage } from "../infrastructure/vbk-request-page.js";
import type { ContactCardSelection } from "../../shared/contracts.js";
import type { MainIpcContext } from "../ipc/context.js";
import type { VbkProductBasicInfo, VbkWriteGateResult, VbkWritePort } from "../agent-runtime/index.js";

type BasicInfoJson = {
  title?: string;
  meetingCity?: string;
  days?: number;
  nights?: number;
};

function basicInfoOf(product: Record<string, unknown> | undefined): BasicInfoJson {
  const basicInfo = (product as { basicInfo?: BasicInfoJson } | undefined)?.basicInfo;
  return basicInfo ?? {};
}

export function buildVbkWritePortFromContext(context: MainIpcContext): VbkWritePort {
  const productOrThrow = (productId: string) => {
    const product = context.db.getProduct(productId);
    if (!product) throw new Error(`本地产品不存在：${productId}`);
    return product;
  };

  return {
    async gate(productId: string): Promise<VbkWriteGateResult> {
      const product = context.db.getProduct(productId);
      if (!product) return { allowed: false, reason: `本地产品不存在：${productId}` };
      const vbkProductId = product.productId?.trim();
      if (!vbkProductId) return { allowed: false, reason: "产品还没有回填 VBK 产品 id（尚未在 VBK 创建）。" };

      const readiness = context.readiness(productId);
      if (!readiness.ready) {
        const blockers = readiness.issues.slice(0, 3).map((issue) => `${issue.label}：${issue.detail}`).join("；");
        return { allowed: false, reason: `程序检查未通过（${blockers || "存在阻塞项"}）` };
      }

      const review = context.db.getItineraryReviewUnlockState(productId);
      if (!review || review.status !== "verified" || !review.approvalId) {
        return {
          allowed: false,
          reason: `尚未完成运营确认（审核解锁状态：${review?.status ?? "无记录"}）`,
        };
      }

      return {
        allowed: true,
        accountKey: review.accountKey,
        vbkProductId,
        confirmationId: review.approvalId,
      };
    },

    async describeBasicInfo(productId: string): Promise<VbkProductBasicInfo> {
      const product = productOrThrow(productId);
      const info = basicInfoOf(product.product);
      const accountName = product.vbkAccount?.trim();
      const fixed = accountName ? context.db.getAccountFixedInfo(accountName) : undefined;
      const butler = fixed?.values.butlerName;
      return {
        title: info.title?.trim() ?? product.name,
        meetingCity: info.meetingCity?.trim() ?? "",
        days: Number(info.days ?? 0),
        nights: Number(info.nights ?? 0),
        ...(typeof fixed?.values.servicePhone === "string" ? { servicePhone: fixed.values.servicePhone } : {}),
        ...(typeof butler === "string"
          ? { butlerName: butler }
          : butler
            ? { butlerName: butler.displayName }
            : {}),
      };
    },

    async writeBasicInfo(productId: string): Promise<{ result: string }> {
      const product = productOrThrow(productId);
      const vbkProductId = product.productId?.trim();
      if (!vbkProductId) throw new Error("产品还没有回填 VBK 产品 id。");
      const accountName = product.vbkAccount?.trim();
      const fixed = accountName ? context.db.getAccountFixedInfo(accountName) : undefined;
      const butler = fixed?.values.butlerName;
      const butlerSelection: ContactCardSelection | undefined = typeof butler === "object" && butler
        ? butler
        : undefined;
      if (!butlerSelection) throw new Error("该账号未配置管家联系人（需要联系人卡 id），无法写入基本信息。");
      const servicePhone = typeof fixed?.values.servicePhone === "string" ? fixed.values.servicePhone : "";
      if (!servicePhone.trim()) throw new Error("该账号未配置 400 电话，无法写入基本信息。");

      const outcome = await context.productWorkflows.runVbkPageExclusive(async () => {
        const page = await getVbkRequestPage(context.browser);
        return ensureBasicInfoApi(page, product.product, vbkProductId, butlerSelection, servicePhone);
      });
      const title = (outcome as { mainName?: string } | undefined)?.mainName;
      return { result: `VBK 产品 ${vbkProductId} 基本信息已保存${title ? `（标题 ${title}）` : ""}` };
    },

    async readBasicInfo(productId: string): Promise<{ title?: string; meetingCity?: string }> {
      const product = productOrThrow(productId);
      const vbkProductId = product.productId?.trim();
      if (!vbkProductId) return {};
      const remote = await context.productWorkflows.runVbkPageExclusive(async () => {
        const page = await getVbkRequestPage(context.browser);
        return getProductBaseInfoApi(page, vbkProductId);
      });
      const base = (remote as { baseInfo?: { mainName?: string; name?: string; departCityName?: string; cityName?: string } }).baseInfo;
      return {
        ...(base?.mainName || base?.name ? { title: String(base.mainName ?? base.name).trim() } : {}),
        ...(base?.cityName || base?.departCityName
          ? { meetingCity: String(base.cityName ?? base.departCityName).trim() }
          : {}),
      };
    },
  };
}
