import { vbkSessionRequest } from "../../infrastructure/vbk-session-request.js";

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

async function createInitialPackage(page: any, product: any, productId: string) {
  const basic = await post(page, "getProductBaseInfo", {
    contentType: "json", head, productId: Number(productId) || productId, needBaseInfo: true,
  }, "VBK 套餐初始化账号查询");
  const vendorId = Number(basic?.baseInfo?.vendorId);
  if (!Number.isInteger(vendorId) || vendorId <= 0) throw new Error("VBK 套餐初始化缺少 vendorId");
  const templateId = await createCustomerTemplate(page, vendorId);
  const days = product.itinerary?.length || Number(product.basicInfo?.days) || 0;
  const packageInfo = {
    name: `${days}日套餐`, needShuttle: "F", vendorConfirmModeId: 2, confirmHour: 4,
    isHotelShareRoom: "F", isContainBedFee: "T", visaInfo: [], vendorResourceCode: "",
    isSmsVBKNotice: "T", isMainPackage: "T", isHotelResource: "T",
    piCustomerInfoTemplateId: templateId,
    resourceNameRule: { days, upgradeType: {}, upgradeValue: {} },
  };
  await post(page, "savePackageItem", {
    contentType: "json", priceInputType: "1", productId: Number(productId) || productId, packageInfo,
  }, "VBK 首套餐接口创建");
  return getPackage(page, productId);
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
  const priceInputType = product.sales?.splitGroup === true ? 5 : 1;
  const description = `${commercial.packageName}。${product.presentation?.recommendation ?? basic.subtitle ?? ""}`;
  const packageInfo = {
    ...current,
    name: commercial.packageName,
    description,
    vendorResourceCode: basic.supplierProductCode ?? current.vendorResourceCode,
    resourceNameRule: { ...(current.resourceNameRule ?? {}), days },
    confirmHour: 4,
    priceInputType,
    isHotelShareRoom: "F",
    isContainBedFee: "F",
    isNeedCustomer: "T",
    isSmsVBKNotice: "T",
    isHotelResource: "F",
  };
  await post(page, "savePackageItem", {
    contentType: "json",
    priceInputType: String(priceInputType),
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
