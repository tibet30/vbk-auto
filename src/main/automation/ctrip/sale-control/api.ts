import { PRODUCT_FORM_LABELS, PRODUCT_TYPE_LABELS } from "../../constants.js";
import { vbkSessionRequest, type VbkSessionRequestBrowser } from "../../../infrastructure/vbk-session-request.js";
import { supportsSmallGroupSettings, type ProductForm } from "../../../../shared/product-form.js";
import { getProductBaseInfoApi } from "../basic-info/api.js";

const SOA = "https://online.ctrip.com/restapi/soa2/15638";
const CREATE_PAGE = "https://vbooking.ctrip.com/ivbk/vendor/saleControlMerge?producttype=0&from=vbk";
const HEAD = { cid: "", ctok: "", cver: "1.0", lang: "01", sid: "8888", syscode: "09", auth: "", extension: [] };
type Json = Record<string, any>;

function record(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
}

function list(value: unknown): Json[] {
  return Array.isArray(value) ? value.filter((item): item is Json => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : [];
}

function assertAck(payload: unknown, label: string): Json {
  const root = record(payload);
  const status = record(root.ResponseStatus);
  const errors = list(status.Errors);
  if (String(status.Ack ?? "") !== "Success" || errors.length) {
    const detail = errors.map((item) => String(item.Message ?? item.Code ?? "")).filter(Boolean).join("、");
    throw new Error(`${label}失败（Ack=${String(status.Ack ?? "缺失")}）${detail ? `：${detail}` : ""}`);
  }
  return root;
}

async function post(page: VbkSessionRequestBrowser, path: string, body: Json, label: string): Promise<Json> {
  const response = await vbkSessionRequest(page, {
    endpoint: `${SOA}/${path}`,
    browserRequestTimeoutMs: 20_000,
    evaluateTimeoutMs: 25_000,
    errorLabel: label,
    headers: { cookieorigin: "https://vbooking.ctrip.com" },
    referrer: CREATE_PAGE,
    body: { contentType: "json", head: HEAD, ...body },
  });
  return assertAck(response.payload, label);
}

export async function loadSaleControlCreateState(page: VbkSessionRequestBrowser): Promise<Json> {
  const headers = { accept: "text/html,application/xhtml+xml,*/*;q=0.8" };
  let status: number;
  let html: string;
  if (page.vbkSessionGetText) {
    const response = await page.vbkSessionGetText({
      endpoint: CREATE_PAGE,
      errorLabel: "VBK 销售控制前置数据读取",
      headers,
    });
    status = response.status;
    html = response.text;
  } else {
    const response = await page.evaluate(async ({ url, requestHeaders }) => {
      const result = await fetch(url, {
        method: "GET",
        credentials: "include",
        headers: requestHeaders,
      });
      return { status: result.status, text: await result.text() };
    }, { url: CREATE_PAGE, requestHeaders: headers });
    status = response.status;
    html = response.text;
  }
  if (status < 200 || status >= 300) {
    throw new Error(`VBK 销售控制前置数据读取失败：HTTP ${status}`);
  }
  const match = html.match(/window\.__INITIAL_STATE__\s*=\s*(.*)/);
  if (!match) throw new Error("VBK 销售控制页面缺少 __INITIAL_STATE__");
  try { return JSON.parse(match[1]); } catch { throw new Error("VBK 销售控制前置数据 JSON 无效"); }
}

function exactOne(items: Json[], key: string, value: string, label: string): Json {
  const matches = items.filter((item) => String(item[key] ?? "").trim() === value);
  if (matches.length !== 1) throw new Error(`${label}「${value}」无法唯一匹配：${matches.length} 个候选`);
  return matches[0];
}

async function resolveBrand(page: VbkSessionRequestBrowser, state: Json, vendorId: number): Promise<Json> {
  const payload = await post(page, "getGlobalProductBrandList", {
    id: String(vendorId), idType: "providerId", locale: "zh-CN", brandSupply: 3, regions: ["CN"],
  }, "VBK 线路品牌查询");
  const brands = list(payload.productBrandDtos);
  const presetId = Number(record(state.initProductBrandDto).brandId ?? record(state.unformatProductBrandDto).brandId);
  const matches = presetId > 0 ? brands.filter((brand) => Number(brand.brandId) === presetId) : brands;
  if (!matches.length) throw new Error("VBK 线路品牌查询未返回可用候选");
  // 新建页没有品牌预选 ID；平台返回顺序就是该账号“线路品牌”下拉顺序，
  // 与历史 UI 逻辑的首个可用项一致。将实际 brandId 写入请求并在创建后回读。
  return matches[0];
}

function enabledChinaChannels(state: Json): { names: string[]; regions: Json[] } {
  const regions = list(state.regionDistributionChannelDtos);
  const china = regions.find((item) => item.region === "CN");
  if (!china) throw new Error("VBK 销售控制缺少 CN 分销区域配置");
  const names = list(china.distributionChannels)
    .filter((channel) => list(channel.childChannels).length === 0)
    .map((channel) => String(channel.channelName ?? ""))
    .filter((name) => name && !["ctripcustomchannel", "tripsystemoversea"].includes(name));
  if (!names.length) throw new Error("VBK 销售控制未返回可用的中国区分销渠道");
  return {
    names,
    regions: regions.map((region) => ({
      ...region,
      isChecked: region.region === "CN" ? "T" : "F",
      distributionChannels: list(region.distributionChannels).map((channel) => ({
        ...channel,
        isChecked: region.region === "CN" && names.includes(String(channel.channelName)) ? "T" : "F",
      })),
    })),
  };
}

function formOf(product: Json): ProductForm {
  const value = String(record(product.sales).productForm || "privateTour") as ProductForm;
  if (!(value in PRODUCT_FORM_LABELS)) throw new Error(`不支持的产品形态：${value}`);
  return value;
}

/** 创建销售控制产品壳并通过 getProductBaseInfo 回读，不触碰页面 DOM。 */
export async function configureProductShellApi(
  page: VbkSessionRequestBrowser,
  product: Json,
): Promise<string> {
  const state = await loadSaleControlCreateState(page);
  const vendorId = Number(state.vendorId ?? record(state.userInfo).vendorId);
  if (!Number.isInteger(vendorId) || vendorId <= 0) throw new Error("VBK 销售控制缺少合法 vendorId");
  const form = formOf(product);
  const type = record(product.sales).productType === "domesticLong" ? "domesticLong" : "domesticShort";
  const contracts = list(state.contractDtos).filter((contract) =>
    list(contract.categoryDtos).some((item) => item.productCategoryName === PRODUCT_TYPE_LABELS[type])
    && list(contract.patternDtos).some((item) => item.productPatternName === PRODUCT_FORM_LABELS[form]));
  if (contracts.length !== 1) throw new Error(`VBK 合同无法按产品类型和形态唯一匹配：${contracts.length} 个候选`);
  const contract = contracts[0];
  const category = exactOne(list(contract.categoryDtos), "productCategoryName", PRODUCT_TYPE_LABELS[type], "产品类型");
  const pattern = exactOne(list(contract.patternDtos), "productPatternName", PRODUCT_FORM_LABELS[form], "产品形态");
  const [brand, channels] = await Promise.all([
    resolveBrand(page, state, vendorId),
    Promise.resolve(enabledChinaChannels(state)),
  ]);
  const maxGroupSize = Math.min(Math.max(Number(record(product.sales).maxGroupSize) || 8, 1), 9);
  const dto: Json = {
    contractId: Number(contract.contractId),
    saleMode: String(contract.saleMode ?? "P"),
    productCategoryId: Number(category.productCategoryId),
    productPatternId: Number(pattern.productPatternId),
    brandId: Number(brand.brandId),
    brandName: String(brand.brandName ?? ""),
    productBrandDto: {
      brandId: Number(brand.brandId),
      brandName: String(brand.brandName ?? ""),
      brandNameEn: String(brand.brandNameEn ?? ""),
      brandLocal: String(brand.brandLocal ?? "zh-CN"),
    },
    priceInputType: 1,
    distributionChannels: channels.names,
    maintainType: "S",
    inputLocale: "zh-CN",
    isExtendToStay: "F",
    regionDistributionChannelDtos: channels.regions,
    desCityDto: {},
    regions: ["CN"],
    tags: [],
    isSecKill: "F",
    joinPurchasePlaza: supportsSmallGroupSettings(form) ? "T" : "F",
    ...(supportsSmallGroupSettings(form) ? { maxSmallGroupSize: maxGroupSize } : {}),
    isPerformanceProduct: "F",
  };
  const saved = await post(page, "saveSaleControlInfo", {
    id: vendorId,
    idType: "providerId",
    saleControlInfoDto: dto,
  }, "VBK 销售控制产品壳创建");
  const productId = String(saved.productId ?? "");
  if (!/^\d+$/.test(productId) || Number(productId) <= 0) throw new Error("VBK 销售控制创建未返回合法产品 ID");
  const readback = await getProductBaseInfoApi(page, productId);
  const sale = record(readback.saleControlInfo);
  if (Number(sale.productCategoryID ?? sale.productCategoryId) !== dto.productCategoryId
    || Number(sale.productPatternID ?? sale.productPatternId) !== dto.productPatternId
    || Number(sale.brandId) !== dto.brandId) {
    throw new Error("VBK 销售控制创建后远端回读不一致");
  }
  if (supportsSmallGroupSettings(form)
    && (sale.joinPurchasePlaza !== "T" || Number(sale.maxSmallGroupSize) !== maxGroupSize)) {
    throw new Error("VBK 拼小团设置创建后远端回读不一致");
  }
  return productId;
}
