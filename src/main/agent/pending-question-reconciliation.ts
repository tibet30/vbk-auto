import type { AgentQuestion } from "../../shared/contracts.js";
import { hasSatisfiedVehicleResource } from "../../shared/research-task-satisfaction.js";
import { hasPersistedCommercialInventory, hasPersistedCommercialPricing } from "../planning/commercial-stage.js";
import { persistedCoverSource } from "./cover-input-reconciliation.js";
import { requiredItineraryPoiSatisfaction } from "./core-preparation-poi-input.js";

type Json = Record<string, unknown>;

function record(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function positiveInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/**
 * Old Agent questions are hints, never the source of truth. Resolve only known
 * data requests with a matching persisted product value. Unknown or ambiguous
 * questions stay visible, even if some other part of the product changed.
 */
export function resolvedProductQuestions(product: Json, questions: readonly AgentQuestion[], options: {
  manualCoverAssetReady?: boolean;
} = {}): Array<{
  id: string; message: string; answer?: string; pause?: boolean;
}> {
  const basic = record(product.basicInfo);
  const operations = record(product.operations);
  const commercial = record(product.commercial);
  const booking = record(operations.bookingControls);
  const butler = record(booking.butler);
  const vehicle = record(operations.vehicleResource);
  const itinerary = Array.isArray(product.itinerary) ? product.itinerary : [];
  const spots = itinerary.flatMap((day) => Array.isArray(record(day).spots) ? record(day).spots as unknown[] : []);

  return questions.flatMap((question) => {
    const target = `${question.id} ${question.label} ${question.placeholder ?? ""}`;
    const source = persistedCoverSource(product);
    // A saved file answers "is there a cover?", never "is this file large
    // enough?" or a request to replace it with a new original.
    if (/封面|cover/i.test(target)
      && /规格|尺寸|像素|高清|原图|重新上传|重传|resize|quality/i.test(target)) {
      if (!options.manualCoverAssetReady) return [];
      const uploaded = question.options?.find((option) =>
        /reupload|重新上传|已上传|高清原图/i.test(`${option.id} ${option.label}`));
      if (question.kind === "single" && !uploaded) return [];
      return [{
        id: question.id,
        ...(uploaded ? { answer: uploaded.id } : {}),
        message: "已重新保存符合携程规格的手动封面原图，无需重复索要图片 ID",
      }];
    }
    if (source === "manualUpload" && question.kind === "single" && /封面|cover/i.test(target)
      && !/更换|替换|修改|调整|偏好|确认/.test(target)) {
      const keep = question.options?.find((option) => /保留.*(?:手动|上传)|keep_manual/i.test(`${option.id} ${option.label}`));
      if (keep) return [{
        id: question.id, answer: keep.id, pause: true,
        message: "已保存手动上传封面，沿用用户已选来源；自动录入会检查原图规格并上传到携程，无需索要图片 ID",
      }];
    }
    // A saved value cannot answer a new preference or approval question.
    if (question.kind !== "text" || /是否|要不要|需不需要|希望|偏好|选择|选哪|改为|修改|调整|更换|替换|确认/.test(target)) return [];
    let message: string | undefined;
    if (/封面|cover|image\s*id|image\s*url/i.test(target)) {
      if (source === "manualUpload") message = "已保存手动上传封面，封面并不缺失；自动录入会先检查原图规格，无需提供 imageId 或 imageUrl";
      else if (source === "ctripLibrary") message = "已选定并保存携程图库封面";
    } else if (/用车.*(?:成本|费用)|(?:成本|费用).*用车|requestedTotalCost/i.test(target)) {
      if (typeof vehicle.requestedTotalCost === "number" && vehicle.requestedTotalCost > 0) message = "全程用车成本已保存";
    } else if (/用车.*资源组|车辆.*资源组|vehicleResource/i.test(target)) {
      if (hasSatisfiedVehicleResource(product)) message = "用车资源组已保存";
    } else if (/成人价|儿童价|起订人数|套餐定价|报价|\bpricing\b/i.test(target)) {
      if (hasPersistedCommercialPricing(commercial.pricing)) message = "套餐定价已保存";
    } else if (/班期|库存|每日配额|\binventory\b/i.test(target)) {
      if (hasPersistedCommercialInventory(commercial.inventory)) message = "班期库存已保存";
    } else if (/副标题|\bsubtitle\b/i.test(target)) {
      if (text(basic.subtitle).length >= 2) message = "副标题已保存";
    } else if (/套餐名称|packageName/i.test(target)) {
      if (text(commercial.packageName)) message = "套餐名称已保存";
    } else if (/管家联系人|管家卡片|butlerContact/i.test(target)) {
      if (positiveInteger(butler.contactCardId) && positiveInteger(butler.providerId) && text(butler.displayName)) message = "管家联系人已保存";
    } else if (/景点.*POI|POI.*景点|poiResolution|待手动配置\s*POI|manual-poi/i.test(target)) {
      const satisfaction = requiredItineraryPoiSatisfaction(product);
      if (satisfaction.hasRequiredPoi && satisfaction.satisfied) message = "行程景点的 POI 已核验并保存";
    }
    return message ? [{ id: question.id, message, ...(source === "manualUpload" && /封面|cover|image\s*id|image\s*url/i.test(target) ? { pause: true } : {}) }] : [];
  });
}
