import { vbkSessionRequest } from "../../infrastructure/vbk-session-request.js";
import { assertVbkAckSuccess } from "../../infrastructure/vbk-response-error.js";
import { PRODUCT_FORM_LABELS, isProductForm } from "../../../shared/product-form.js";
import { ITINERARY_CTRIP_PLATFORM_HOTEL } from "../../../shared/itinerary-hotel.js";

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

const PACKAGE_CREATE_READBACK_ATTEMPTS = 6;
const PACKAGE_CREATE_READBACK_INTERVAL_MS = 1_000;

interface PackageApiOptions {
  pause?: (milliseconds: number) => Promise<void>;
}

function assertOk(payload: any, label: string) {
  return assertVbkAckSuccess(payload, label);
}

async function post(page: any, path: string, body: Record<string, unknown>, label: string) {
  const response = await vbkSessionRequest(page, {
    endpoint: `https://online.ctrip.com/restapi/soa2/15638/${path}`,
    browserRequestTimeoutMs: 15_000,
    evaluateTimeoutMs: 20_000,
    errorLabel: label,
    headers: { cookieorigin: "https://vbooking.ctrip.com" },
    body: { contentType: "json", head, ...body },
  });
  assertOk(response.payload, label);
  return response.payload as any;
}

async function getPackage(page: any, productId: string, priceInputType: number, required = true) {
  const payload = await post(page, "getPackageList", {
    productId: Number(productId) || productId,
    priceInputType,
  }, "VBK 套餐查询");
  const item = Array.isArray(payload?.itemList) ? payload.itemList[0] : undefined;
  if (!item && required) throw new Error("VBK 尚未返回套餐，无法通过接口设置套餐管理。");
  return item;
}

async function createCustomerTemplate(page: any, vendorId: number) {
  const response = await vbkSessionRequest(page, {
    endpoint: "https://online.ctrip.com/restapi/soa2/20242/saveCustomerCpntTemplateInfo",
    browserRequestTimeoutMs: 15_000,
    evaluateTimeoutMs: 20_000,
    errorLabel: "VBK 套餐客资模板创建",
    headers: { accept: "application/json", cookieorigin: "https://vbooking.ctrip.com" },
    body: {
      businessData: encodeURIComponent(JSON.stringify({ from: "vbk", resourceId: 0, resourceVendorId: vendorId })),
      piCategoryId: 1173,
      piCustomerInfoTemplateId: 0,
      header: { locale: "zh-CN", code: "vaction" },
      componentItems: [
        { code: "title", name: "预订用户填写信息", itemValue: [] },
        { code: "fill_in_number_limit", name: "每单填写出行人数", isNeed: true, isDisplay: true, componentType: "radio", itemValue: [{ itemId: "A", itemValue: "全部出行人", isChecked: true }] },
        { code: "is_need_certificate", name: "是否需要证件", isNeed: true, isDisplay: true, componentType: "radio", itemValue: [{ itemId: "T", itemValue: "是", isChecked: true }, { itemId: "F", itemValue: "否", isChecked: false }] },
        { code: "customer_info", name: "出行人信息", isNeed: true, isDisplay: true, componentType: "radio", itemValue: [{ itemId: "1", itemValue: "出行人信息模板", isChecked: true }, { itemId: "2", itemValue: "自定义资料项包", isChecked: false }] },
        { code: "customer_info_package", name: "出行人资料项包", isNeed: true, isDisplay: false, componentType: "select", itemValue: [{ itemId: "5122001", itemValue: "个人信息", isChecked: false }] },
        { code: "customer_info_template", name: "出行人信息模板", isNeed: true, isDisplay: true, componentType: "select", itemValue: [{ itemId: "auto_match_template", itemValue: "自动匹配模板", isChecked: true }] },
      ],
    },
  });
  assertOk(response.payload, "VBK 套餐客资模板创建");
  const templateId = Number((response.payload as any)?.cpntTemplateInfoId);
  if (!Number.isInteger(templateId) || templateId <= 0) throw new Error("VBK 套餐客资模板未返回合法 ID");
  return templateId;
}

function packageDays(product: any, current?: any) {
  return product.itinerary?.length || current?.resourceNameRule?.days || Number(product.basicInfo?.days) || 0;
}

async function readCreatedPackage(
  page: any,
  productId: string,
  priceInputType: number,
  options: PackageApiOptions,
) {
  const pause = options.pause ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  for (let attempt = 1; attempt <= PACKAGE_CREATE_READBACK_ATTEMPTS; attempt += 1) {
    const item = await getPackage(page, productId, priceInputType, false);
    if (item) return item;
    if (attempt < PACKAGE_CREATE_READBACK_ATTEMPTS) await pause(PACKAGE_CREATE_READBACK_INTERVAL_MS);
  }
  throw new Error("VBK 首套餐创建已返回成功，但套餐列表仍为空；请检查套餐管理页是否生成资源。");
}

async function createInitialPackage(
  page: any,
  product: any,
  productId: string,
  packageName: string,
  priceInputType: number,
  options: PackageApiOptions,
) {
  const basic = await post(page, "getProductBaseInfo", {
    productId: Number(productId) || productId,
    needBaseInfo: true,
  }, "VBK 套餐初始化账号查询");
  const vendorId = Number(basic?.baseInfo?.vendorId);
  if (!Number.isInteger(vendorId) || vendorId <= 0) throw new Error("VBK 套餐初始化缺少 vendorId");
  const templateId = await createCustomerTemplate(page, vendorId);
  const days = packageDays(product);
  const packageInfo = {
    name: packageName, needShuttle: "F", vendorConfirmModeId: 2, confirmHour: 4,
    isHotelShareRoom: "F", isContainBedFee: "T", visaInfo: [], vendorResourceCode: "",
    isSmsVBKNotice: "T", isMainPackage: "T", isHotelResource: ITINERARY_CTRIP_PLATFORM_HOTEL.packageIsHotelResource,
    priceInputType,
    piCustomerInfoTemplateId: templateId,
    resourceNameRule: { days, upgradeType: {}, upgradeValue: {} },
  };
  await post(page, "savePackageItem", {
    priceInputType: String(priceInputType), productId: Number(productId) || productId, packageInfo,
  }, "VBK 首套餐接口创建");
  return readCreatedPackage(page, productId, priceInputType, options);
}

export function resolvePackageName(product: any): string {
  const commercialName = String(product.commercial?.packageName ?? "").trim();
  if (commercialName) return commercialName;
  const basic = product.basicInfo ?? {};
  const sales = product.sales ?? {};
  const destination = String(basic.meetingCity || basic.destinationCity || "").trim() || "目的地";
  const days = Number(basic.days);
  const nights = Number.isFinite(Number(basic.nights)) ? Number(basic.nights) : days - 1;
  const productForm = sales.productForm;
  if (!Number.isInteger(days) || days < 1 || !Number.isInteger(nights) || nights < 0 || !isProductForm(productForm)) {
    throw new Error("产品骨架不完整，无法自动生成套餐名称。");
  }
  return `${destination}${days}天${nights}晚${PRODUCT_FORM_LABELS[productForm]}`;
}

/** 直接调用 Tour Helper 同源协议更新套餐，并回读关键字段。 */
export async function ensurePackageApi(page: any, product: any, productId: string, options: PackageApiOptions = {}) {
  const commercial = product.commercial ?? {};
  const basic = product.basicInfo ?? {};
  const packageName = resolvePackageName(product);
  const priceInputType = product.sales?.splitGroup === true ? 5 : 1;
  const current =
    (await getPackage(page, productId, priceInputType, false))
    ?? (await createInitialPackage(page, product, productId, packageName, priceInputType, options));
  const days = packageDays(product, current);
  const description = `${packageName}。${product.presentation?.recommendation ?? basic.subtitle ?? ""}`;
  const packageInfo = {
    ...current,
    name: packageName,
    description,
    vendorResourceCode: basic.supplierProductCode ?? current.vendorResourceCode,
    resourceNameRule: { ...(current.resourceNameRule ?? {}), days },
    confirmHour: 4,
    priceInputType,
    isHotelShareRoom: "F",
    isContainBedFee: "F",
    isNeedCustomer: "T",
    isSmsVBKNotice: "T",
    isHotelResource: ITINERARY_CTRIP_PLATFORM_HOTEL.packageIsHotelResource,
  };
  await post(page, "savePackageItem", {
    contentType: "json",
    priceInputType: String(priceInputType),
    productId: Number(productId) || productId,
    packageInfo,
  }, "VBK 套餐保存");
  const saved = await getPackage(page, productId, priceInputType);
  const checks = [
    ["套餐名称", saved.name, packageInfo.name],
    ["供应商套餐编号", saved.vendorResourceCode, packageInfo.vendorResourceCode],
    ["套餐天数", saved.resourceNameRule?.days, days],
    ["确认时长", saved.confirmHour, 4],
    ["是否含酒店", saved.isHotelResource, packageInfo.isHotelResource],
  ] as const;
  const failed = checks.find(([, actual, expected]) => String(actual ?? "") !== String(expected ?? ""));
  if (failed) throw new Error(`套餐接口回读不一致：${failed[0]}=${String(failed[1])}，期望 ${String(failed[2])}`);
  return { packageName: saved.name, savedWith: "tour-helper-api", verified: true, days };
}
