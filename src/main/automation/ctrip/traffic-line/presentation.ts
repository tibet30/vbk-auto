import { postTrafficLineSoa, record, text, type JsonRecord, type TrafficLinePage } from "./client.js";

export interface TrafficLinePresentationSnapshot {
  recommendations: string[];
  richText: string;
  raw: JsonRecord;
}

export async function ensureTrafficLinePresentation(
  page: TrafficLinePage,
  parentProductId: string,
  childProductId: string,
): Promise<{ inherited: boolean; verified: TrafficLinePresentationSnapshot }> {
  const source = await readTrafficLinePresentation(page, parentProductId);
  const current = await readTrafficLinePresentation(page, childProductId);
  if (samePresentation(source, current)) return { inherited: true, verified: current };

  await postTrafficLineSoa(page, "20698", "createProductDraft", {
    productId: childProductId, module: "desc",
  }, "创建子产品图文草稿");
  const info = structuredClone(source.raw);
  const productDesc = record(info.productDesc);
  if (!productDesc) throw new Error("母产品图文缺少 productDesc，无法安全复制到子产品。");
  const saved = await postTrafficLineSoa(page, "15638", "savedescriptioninfo", {
    dto: {
      productId: childProductId,
      saveType: 3,
      pmRcmdItems: structuredClone(Array.isArray(info.pmRcmdItems) ? info.pmRcmdItems : []),
      productDesc: { ...productDesc, productId: childProductId },
      productDescNew: null,
      addInfoCode: info.addInfoCode,
    },
  }, "复制子产品图文");
  if (saved.success !== true) throw new Error("复制子产品图文失败：接口未返回 success=true。");
  const verified = await readTrafficLinePresentation(page, childProductId);
  if (!samePresentation(source, verified)) throw new Error("子产品图文回读与母产品不一致。");
  return { inherited: false, verified };
}

export async function readTrafficLinePresentation(page: TrafficLinePage, productId: string): Promise<TrafficLinePresentationSnapshot> {
  const payload = await postTrafficLineSoa(page, "15638", "getdescriptionInfo", { productId }, "读取产品图文");
  const info = record(payload.info);
  if (!info) throw new Error("读取产品图文失败：响应缺少 info。");
  const productDesc = record(info.productDesc);
  const richText = text(productDesc?.productDesc);
  if (!richText) throw new Error("读取产品图文失败：响应缺少产品特色富文本。");
  const recommendations = Array.isArray(info.pmRcmdItems)
    ? info.pmRcmdItems.flatMap((item) => text(record(item)?.rcmdDesc) ? [text(record(item)?.rcmdDesc)] : [])
    : [];
  return { recommendations, richText, raw: info };
}

export function samePresentation(a: TrafficLinePresentationSnapshot, b: TrafficLinePresentationSnapshot): boolean {
  return a.richText === b.richText
    && a.recommendations.length === b.recommendations.length
    && a.recommendations.every((textValue, index) => b.recommendations[index] === textValue);
}
