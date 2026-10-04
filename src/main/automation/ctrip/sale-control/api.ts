import { PRODUCT_FORM_LABELS, PRODUCT_TYPE_LABELS } from "../../constants.js";
import { vbkSessionRequest, type VbkSessionRequestBrowser } from "../../../infrastructure/vbk-session-request.js";
import { assertVbkAckSuccess } from "../../../infrastructure/vbk-response-error.js";
import { supportsSmallGroupSettings, type ProductForm } from "../../../../shared/product-form.js";
import { getProductBaseInfoApi } from "../basic-info/api.js";
import { fetchCurrentUserInfo } from "../../../infrastructure/current-user.js";
import { resolveCreateBusinessContext } from "./business-context.js";
import type { VbkSessionNativeRequest } from "../../../infrastructure/vbk-session-request.js";

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
  return assertVbkAckSuccess(payload, label) as Json;
}

async function post(page: VbkSessionRequestBrowser, path: string, body: Json, label: string,
  businessContext?: VbkSessionNativeRequest["businessContext"]): Promise<Json> {
  const response = await vbkSessionRequest(page, {
    endpoint: `${SOA}/${path}`,
    browserRequestTimeoutMs: 20_000,
    evaluateTimeoutMs: 25_000,
    errorLabel: label,
    headers: { cookieorigin: "https://vbooking.ctrip.com" },
    referrer: CREATE_PAGE,
    referrerPolicy: "no-referrer-when-downgrade",
    businessContext,
    body: { contentType: "json", head: HEAD, ...body },
  });
  return assertAck(response.payload, label);
}

export async function loadSaleControlCreateState(page: VbkSessionRequestBrowser): Promise<Json> {
  const user = await fetchCurrentUserInfo(page);
  if (!user?.partyId) throw new Error("VBK 销售控制无法确认当前账号供应商 ID");
  const state = await post(page, "getSaleControlInfo", {
    id: user.partyId, idType: "providerId",
  }, "VBK 销售控制前置数据读取");
  if (Number(state.vendorId) !== user.partyId) throw new Error("VBK 销售控制配置与当前账号供应商不一致");
  if (!Array.isArray(state.contractDtos) || !Array.isArray(state.regionDistributionChannelDtos)) {
    throw new Error("VBK 销售控制接口缺少合同或分销区域配置");
  }
  return state;
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
  // 与官方私家团新建页的默认渠道一致，父渠道 merchants 也需要保留。
  const defaultChannels = new Set(["ctripshop", "bestone", "youtripshop", "bestoneb2b", "tripsystem", "ctrip", "merchants", "routine108"]);
  const names = list(china.distributionChannels)
    .map((channel) => String(channel.channelName ?? ""))
    .filter((name) => defaultChannels.has(name));
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
  onCreated?: (productId: string) => void | Promise<void>,
): Promise<string> {
  const state = await loadSaleControlCreateState(page);
  const vendorId = Number(state.vendorId ?? record(state.userInfo).vendorId);
  if (!Number.isInteger(vendorId) || vendorId <= 0) throw new Error("VBK 销售控制缺少合法 vendorId");
  const form = formOf(product);
  const businessContext = await resolveCreateBusinessContext(page, vendorId, form);
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
    // 软件使用携程资源配置；官方私家团的新建请求使用 P。
    maintainType: "P",
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
    id: String(vendorId),
    idType: "providerId",
    saleControlInfoDto: dto,
  }, "VBK 销售控制产品壳创建", businessContext);
  const productId = String(saved.productId ?? "");
  if (!/^\d+$/.test(productId) || Number(productId) <= 0) throw new Error("VBK 销售控制创建未返回合法产品 ID");
  await onCreated?.(productId);
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

/** Read-only recovery after the shell ID was persisted but creation readback was interrupted. */
export async function verifyExistingProductShellApi(page: VbkSessionRequestBrowser, product: Json, productId: string): Promise<void> {
  const state = await loadSaleControlCreateState(page);
  const form = formOf(product);
  const type = record(product.sales).productType === "domesticLong" ? "domesticLong" : "domesticShort";
  const readback = await getProductBaseInfoApi(page, productId);
  const sale = record(readback.saleControlInfo);
  const matches = list(state.contractDtos).filter(contract =>
    list(contract.categoryDtos).some(item => item.productCategoryName === PRODUCT_TYPE_LABELS[type]
      && Number(item.productCategoryId) === Number(sale.productCategoryID ?? sale.productCategoryId))
    && list(contract.patternDtos).some(item => item.productPatternName === PRODUCT_FORM_LABELS[form]
      && Number(item.productPatternId) === Number(sale.productPatternID ?? sale.productPatternId)));
  if (matches.length !== 1 || !(Number(sale.brandId) > 0)) {
    throw new Error("已有产品壳销售控制回读不一致，不能继续录入。");
  }
  const maxGroupSize = Math.min(Math.max(Number(record(product.sales).maxGroupSize) || 8, 1), 9);
  if (supportsSmallGroupSettings(form)
    && (sale.joinPurchasePlaza !== "T" || Number(sale.maxSmallGroupSize) !== maxGroupSize)) {
    throw new Error("已有产品壳拼小团设置回读不一致，不能继续录入。");
  }
}
