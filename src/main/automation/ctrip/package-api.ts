import { vbkSessionRequest } from "../../infrastructure/vbk-session-request.js";
import { productSectionUrl } from "../constants.js";
import { fillAndSavePackage } from "./package.js";
import { delay } from "./utils.js";

const head = {
  cid: "",
  ctok: "",
  cver: "1.0",
  lang: "01",
  sid: "8888",
  syscode: "09",
  auth: "",
  extension: [],
};

function assertOk(payload: any, label: string) {
  const status = payload?.ResponseStatus;
  if (status?.Ack === "Failure" || (Array.isArray(status?.Errors) && status.Errors.length)) {
    throw new Error(`${label}失败：${JSON.stringify(status.Errors ?? status).slice(0, 500)}`);
  }
}

async function post(page: any, path: string, body: Record<string, unknown>, label: string) {
  const response = await vbkSessionRequest(page, {
    endpoint: `https://online.ctrip.com/restapi/soa2/15638/${path}`,
    browserRequestTimeoutMs: 15_000,
    evaluateTimeoutMs: 20_000,
    errorLabel: label,
    body,
  });
  assertOk(response.payload, label);
  return response.payload as any;
}

async function getPackage(page: any, productId: string, required = true) {
  const payload = await post(page, "getPackageList", {
    contentType: "json",
    head,
    productId: Number(productId) || productId,
    priceInputType: 1,
  }, "VBK 套餐查询");
  const item = Array.isArray(payload?.itemList) ? payload.itemList[0] : undefined;
  if (!item && required) throw new Error("VBK 尚未返回套餐，无法通过接口设置套餐管理。");
  return item;
}

async function createInitialPackage(page: any, product: any, productId: string) {
  await page.goto(productSectionUrl(productId, "packageManage"), {
    waitUntil: "domcontentloaded",
  });
  const created = await fillAndSavePackage(page, product);
  if (created && "saveDisabled" in created && created.saveDisabled) {
    throw new Error(
      `VBK 首个套餐未保存：${"skipped" in created ? created.skipped : "保存按钮不可用"}`,
    );
  }
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const saved = await getPackage(page, productId, false);
    if (saved) return saved;
    await delay(1_000);
  }
  throw new Error("VBK 套餐页已执行首次保存，但接口回读仍为空。");
}

/** 直接调用 Tour Helper 同源协议更新套餐，并回读关键字段。 */
export async function ensurePackageApi(page: any, product: any, productId: string) {
  const commercial = product.commercial;
  const basic = product.basicInfo ?? {};
  if (!commercial?.packageName) throw new Error("缺少 commercial.packageName，无法设置套餐。");
  const current =
    (await getPackage(page, productId, false))
    ?? (await createInitialPackage(page, product, productId));
  const days = product.itinerary?.length || current.resourceNameRule?.days || 0;
  const description = `${commercial.packageName}。${product.presentation?.recommendation ?? basic.subtitle ?? ""}`;
  const packageInfo = {
    ...current,
    name: commercial.packageName,
    description,
    vendorResourceCode: basic.supplierProductCode ?? current.vendorResourceCode,
    resourceNameRule: { ...(current.resourceNameRule ?? {}), days },
    confirmHour: 4,
    priceInputType: 1,
    isHotelShareRoom: "F",
    isContainBedFee: "F",
    isNeedCustomer: "T",
    isSmsVBKNotice: "T",
    isHotelResource: "F",
  };
  await post(page, "savePackageItem", {
    contentType: "json",
    priceInputType: "1",
    productId: Number(productId) || productId,
    packageInfo,
  }, "VBK 套餐保存");
  const saved = await getPackage(page, productId);
  const checks = [
    ["套餐名称", saved.name, packageInfo.name],
    ["供应商套餐编号", saved.vendorResourceCode, packageInfo.vendorResourceCode],
    ["套餐天数", saved.resourceNameRule?.days, days],
    ["确认时长", saved.confirmHour, 4],
  ] as const;
  const failed = checks.find(([, actual, expected]) => String(actual ?? "") !== String(expected ?? ""));
  if (failed) throw new Error(`套餐接口回读不一致：${failed[0]}=${String(failed[1])}，期望 ${String(failed[2])}`);
  return { packageName: saved.name, savedWith: "tour-helper-api", verified: true, days };
}
