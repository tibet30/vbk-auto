/**
 * VBK 新版结构化条款接口。
 *
 * 契约来源：真实 newResourceClause 页面与 tour-chrome-extension 的
 * saveClauses.ts。通过统一账号会话请求保存并回读，无需页面执行上下文。
 */

import { vbkSessionRequest, type VbkSessionRequestBrowser } from "../../infrastructure/vbk-session-request.js";

type ClauseRecord = Record<string, any>;
interface ClauseElement {
  componentCode?: unknown;
  elementCode?: unknown;
  elementValue?: unknown;
  value?: unknown;
}
interface SelectedClauseItem {
  clauseItemId: number;
  secondClassTypeId: number;
  elementDtos: ClauseElement[];
}

const CLAUSE_HEAD = {
  cid: "",
  ctok: "",
  cver: "1.0",
  lang: "01",
  sid: "8888",
  syscode: "09",
  auth: "",
  extension: [],
};

export const REQUIRED_CLAUSE_IDS = {
  // 当前产品 operations.mealsIncluded / 导游文案均明确为持证中文导游。
  mandarinGuide: 3014,
  // 私家团/拼小团均提供目的地当地专属用车，特殊路段可按当地规定换用小型车。
  localExclusiveVehicle: 134,
  // 服务标准页的住宿为必选：行程所列酒店费用 + 2 人/间。
  itineraryHotelIncluded: 10095,
  hotelTwoPerRoom: 7,
  // 当前产品儿童价不含床位，平台新版仍要求明确选择儿童住宿口径。
  childNoBed: 10091,
  // 当前产品明确包含酒店住宿，费用包含页必须勾选住宿条款。
  lodgingIncluded: 1079,
  // 产品包含儿童价，因此采用允许未成年人、但必须由成人陪同的规则。
  minorWithAdult: 46,
  outboundTransportExcluded: 1082,
  excessBaggageAndPersonalExpenses: 1120,
  pregnancyBookingRestriction: 1095,
  flightForceMajeureNotice: 98,
  complimentaryActivityNotice: 383,
  // 费用包含页：成人行程所列景点/场馆首道大门票。
  adultTicketIncluded: 13,
  // 费用包含页：儿童行程所列景点/场馆首道大门票。
  childTicketIncluded: 10087,
} as const;

const LODGING_SELF_PAY_NOTE = "单房差及儿童占床费用（如产生），具体金额以出行前实际确认为准";
// Saved platform clause IDs. The page-context payload is kept ID-only as well.
export const DEFAULT_SELECTED_CLAUSE_IDS = {
  1: [38536, 134, 10095, 7, 10091, 13, 10087, 3014],
  2: [REQUIRED_CLAUSE_IDS.outboundTransportExcluded, 1079, REQUIRED_CLAUSE_IDS.excessBaggageAndPersonalExpenses],
  3: [3031, 46, REQUIRED_CLAUSE_IDS.pregnancyBookingRestriction],
  4: [
    3011,
    REQUIRED_CLAUSE_IDS.flightForceMajeureNotice,
    REQUIRED_CLAUSE_IDS.complimentaryActivityNotice,
    478,
    37682,
    642,
    32716,
    563,
  ],
} as const;

export function formatSelectedClauseItems(clauseTypeDtos: ClauseRecord[] = []): SelectedClauseItem[] {
  const result: SelectedClauseItem[] = [];
  for (const type of clauseTypeDtos ?? []) {
    const selectedItems = [
      ...(type.clauseItemDtos ?? []),
      ...(type.containers ?? []).flatMap((container: ClauseRecord) =>
        (container.clauseItemDtos ?? []).map((item: ClauseRecord) => ({
          ...item,
          selected: container.selectedClauseItemId == null
            ? item.selected
            : String(item.clauseItemId) === String(container.selectedClauseItemId) ? "T" : "F",
        })),
      ),
    ].filter((item: ClauseRecord) => {
      if (item.itemType != null && item.itemType !== "F") return false;
      if (item.isShow != null && item.isShow !== "T") return false;
      if (item.hasSelectBox === "F") return true;
      return item.selected === "T";
    });
    for (const item of selectedItems) {
      result.push({
        clauseItemId: item.clauseItemId,
        secondClassTypeId: type.clauseTypeId,
        elementDtos: (item.clauseComponentDtos ?? []).map((component: ClauseRecord) => {
          const element = component.componentElementDtos?.find(
            (candidate: ClauseRecord) => candidate.elementCode === component.value,
          );
          return {
            componentCode: component.componentCode,
            value: element?.elementValue ?? component.value,
            ...(element ? { elementCode: element.elementCode } : {}),
          };
        }),
      });
    }
  }
  return result;
}

export function ensureRequiredClause(
  items: SelectedClauseItem[],
  clauseTypeDtos: ClauseRecord[] = [],
  clauseItemId: number,
): SelectedClauseItem[] {
  if (items.some((item) => item.clauseItemId === clauseItemId)) return items;
  for (const type of clauseTypeDtos ?? []) {
    const candidates = [
      ...(type.clauseItemDtos ?? []),
      ...(type.containers ?? []).flatMap((container: ClauseRecord) => container.clauseItemDtos ?? []),
    ];
    const target = candidates.find((item: ClauseRecord) => item.clauseItemId === clauseItemId);
    if (!target) continue;
    return [
      ...items,
      {
        clauseItemId: target.clauseItemId,
        secondClassTypeId: type.clauseTypeId,
        elementDtos: (target.clauseComponentDtos ?? []).map((component: ClauseRecord) => {
          const element = component.componentElementDtos?.find(
            (candidate: ClauseRecord) => candidate.elementCode === component.value,
          );
          return {
            componentCode: component.componentCode,
            value: element?.elementValue ?? component.value,
            ...(element ? { elementCode: element.elementCode } : {}),
          };
        }),
      },
    ];
  }
  throw new Error(`VBK 条款包缺少必选条款 ${clauseItemId}`);
}

export function setClauseComponentValue(
  items: SelectedClauseItem[],
  clauseItemId: number,
  componentCode: string,
  value: unknown,
): SelectedClauseItem[] {
  let found = false;
  const next = items.map((item) => {
    if (item.clauseItemId !== clauseItemId) return item;
    const elements = (item.elementDtos ?? []).map((element) => {
      if (element.componentCode !== componentCode) return element;
      found = true;
      return { ...element, value };
    });
    return { ...item, elementDtos: elements };
  });
  if (!found) throw new Error(`VBK 条款 ${clauseItemId} 缺少组件 ${componentCode}`);
  return next;
}

const ADULT_TICKET_REMARKS_COMPONENT = "landticketremarks";
const CHILD_TICKET_REMARKS_COMPONENT = "landticket2";

export async function saveStructuredProductClauses(
  page: VbkSessionRequestBrowser,
  productId: string | number,
  options: { productForm?: string; adultTicketInclusionText?: string; childBookable?: boolean } = {},
) {
  const isFreeTravel = options?.productForm === "freeTravel";
  const adultTicketInclusionText = String(options?.adultTicketInclusionText ?? "").trim();
  const head = CLAUSE_HEAD;
  const requiredIds = REQUIRED_CLAUSE_IDS;
  const childBookable = options?.childBookable !== false;
  const defaultSelectedClauseIds: Record<number, readonly number[]> = {
    ...DEFAULT_SELECTED_CLAUSE_IDS,
    1: DEFAULT_SELECTED_CLAUSE_IDS[1].filter((id) => childBookable || ![10091, 10087].includes(id)),
  };
  const lodgingSelfPayNote = LODGING_SELF_PAY_NOTE;
  const adultTicketRemarksComponent = ADULT_TICKET_REMARKS_COMPONENT;
  const childTicketRemarksComponent = CHILD_TICKET_REMARKS_COMPONENT;
  const helpers = {
    request: async (url: string, body: object, contentType = "application/json"): Promise<ClauseRecord> => {
      const response = await vbkSessionRequest(page, {
        endpoint: url, body, errorLabel: `VBK 条款 ${url.split("/").pop()}`,
        browserRequestTimeoutMs: 20_000, evaluateTimeoutMs: 25_000,
        headers: { "content-type": contentType, cookieorigin: "https://vbooking.ctrip.com" },
      });
      const data = response.payload as ClauseRecord;
      const ack = data?.ResponseStatus?.Ack;
      const errors = data?.ResponseStatus?.Errors;
      if (ack !== "Success" || (Array.isArray(errors) && errors.length)) {
        const detail = errors?.map((error: ClauseRecord) => error.Message ?? error.ErrorCode).join("；") || ack || "缺少成功确认";
        throw new Error(`${url.split("/").pop()} 失败：${detail}`);
      }
      return data;
    },
    format: formatSelectedClauseItems,
    ensure: ensureRequiredClause,
    setValue: setClauseComponentValue,
  };
  const savedTabs: Array<{ tabEnum: number; packageId: unknown; itemCount: number }> = [];
  // VBK 会在保存其它页签时做跨页校验；先落住宿费用页，避免“请勾选住宿条款”。
  for (const tabEnum of [2, 1, 3, 4]) {
    const productClause = await helpers.request(
      "https://online.ctrip.com/restapi/soa2/15638/listProductClauses",
      { contentType: "json", head, productId: String(productId), tabEnum },
    );
    const central = productClause.centralDataDto;
    if (!central?.additionalInfoDto?.firstClassTypeIds) {
      throw new Error(`条款页签 ${tabEnum} 缺少 centralDataDto`);
    }
    const getBody = {
      ...central,
      clauseFilterConditionDto: central.filterConditionDto,
      firstClassClauseTypeIds: central.additionalInfoDto.firstClassTypeIds,
      additionalInfoDto: { ...central.additionalInfoDto, isTra: "F", isChildrenToNew: "T" },
    };
    delete getBody.filterConditionDto;
    const clausePackage = await helpers.request(
      "https://online.ctrip.com/restapi/soa2/20046/getClausePackage",
      getBody,
      "text/plain;charset=UTF-8",
    );
    let items = helpers.format(clausePackage.clauseTypeDtos);
    if (tabEnum === 1 && !isFreeTravel) {
      items = helpers.ensure(items, clausePackage.clauseTypeDtos, requiredIds.mandarinGuide);
      items = helpers.ensure(items, clausePackage.clauseTypeDtos, requiredIds.localExclusiveVehicle);
      items = helpers.ensure(items, clausePackage.clauseTypeDtos, requiredIds.itineraryHotelIncluded);
      items = helpers.ensure(items, clausePackage.clauseTypeDtos, requiredIds.hotelTwoPerRoom);
      if (childBookable) items = helpers.ensure(items, clausePackage.clauseTypeDtos, requiredIds.childNoBed);
    }
    if (tabEnum === 1 && adultTicketInclusionText) {
      items = helpers.ensure(items, clausePackage.clauseTypeDtos, requiredIds.adultTicketIncluded);
      items = helpers.setValue(items, requiredIds.adultTicketIncluded, adultTicketRemarksComponent, adultTicketInclusionText);
      if (childBookable) {
        items = helpers.ensure(items, clausePackage.clauseTypeDtos, requiredIds.childTicketIncluded);
        items = helpers.setValue(items, requiredIds.childTicketIncluded, childTicketRemarksComponent, adultTicketInclusionText);
      }
    }
    if (tabEnum === 2 && !isFreeTravel) {
      items = helpers.ensure(items, clausePackage.clauseTypeDtos, requiredIds.lodgingIncluded);
      items = helpers.setValue(items, requiredIds.lodgingIncluded, "otherfeewithout1", lodgingSelfPayNote);
    }
    if (tabEnum === 3 && !isFreeTravel) items = helpers.ensure(items, clausePackage.clauseTypeDtos, requiredIds.minorWithAdult);
    if (!isFreeTravel) {
      for (const clauseItemId of defaultSelectedClauseIds[tabEnum] ?? []) {
        items = helpers.ensure(items, clausePackage.clauseTypeDtos, clauseItemId);
      }
    }
    let savePackage;
    try {
      savePackage = await helpers.request(
        "https://online.ctrip.com/restapi/soa2/20046/saveClausePackage",
        {
          ...central,
          firstClassClauseTypeIds: central.additionalInfoDto.firstClassTypeIds,
          clausePackageItemDtos: items,
          requestBaseData: { locale: "zh-CN" },
          pICategoryId: central.filterConditionDto.pICategoryId,
        },
        "text/plain;charset=UTF-8",
      );
    } catch (error) {
      throw new Error(`条款页签 ${tabEnum} 保存失败：${error instanceof Error ? error.message : String(error)}`);
    }
    const packageId = savePackage.clausePackageId;
    if (!packageId) throw new Error(`条款页签 ${tabEnum} 保存成功但未返回条款包 ID`);
    await helpers.request(
      "https://online.ctrip.com/restapi/soa2/15638/saveProductClauses.json",
      {
        contentType: "json",
        head,
        packageId,
        saveType: 3,
        productId: String(productId),
        tabEnum,
        clauseEditDtos: [],
        unBookingRuleDtos: [],
      },
    );
    const persistedClauseData = await helpers.request(
      "https://online.ctrip.com/restapi/soa2/15638/listProductClauses",
      { contentType: "json", head, productId: String(productId), tabEnum },
    );
    const persistedCentral = persistedClauseData.centralDataDto;
    const persistedBody = {
      ...persistedCentral,
      clauseFilterConditionDto: persistedCentral.filterConditionDto,
      firstClassClauseTypeIds: persistedCentral.additionalInfoDto.firstClassTypeIds,
      additionalInfoDto: { ...persistedCentral.additionalInfoDto, isTra: "F", isChildrenToNew: "T" },
    };
    delete persistedBody.filterConditionDto;
    const persistedPackage = await helpers.request(
      "https://online.ctrip.com/restapi/soa2/20046/getClausePackage",
      persistedBody,
      "text/plain;charset=UTF-8",
    );
    const persistedIds = new Set(helpers.format(persistedPackage.clauseTypeDtos).map((item) => item.clauseItemId));
    const missingIds = isFreeTravel
      ? []
      : (defaultSelectedClauseIds[tabEnum] ?? []).filter((id) => !persistedIds.has(id));
    if (missingIds.length > 0) {
      throw new Error(`条款页签 ${tabEnum} 保存后回读缺少条款：${missingIds.join(",")}`);
    }
    if (tabEnum === 1 && adultTicketInclusionText) {
      const persistedItems = helpers.format(persistedPackage.clauseTypeDtos);
      const persistedAdultTicket = persistedItems.find(
        (item) => item.clauseItemId === requiredIds.adultTicketIncluded,
      );
      if (!persistedAdultTicket) {
        throw new Error(`条款页签 1 保存后回读缺少成人门票条款：${requiredIds.adultTicketIncluded}`);
      }
      const persistedRemarks = (persistedAdultTicket.elementDtos ?? []).find(
        (element) => element.componentCode === adultTicketRemarksComponent,
      );
      if (persistedRemarks?.value !== adultTicketInclusionText) {
        throw new Error("条款页签 1 保存后回读的成人门票景点文本不一致");
      }
      const persistedChildTicket = persistedItems.find(
        (item) => item.clauseItemId === requiredIds.childTicketIncluded,
      );
      const persistedChildRemarks = (persistedChildTicket?.elementDtos ?? []).find(
        (element) => element.componentCode === childTicketRemarksComponent,
      );
      if (childBookable && persistedChildRemarks?.value !== adultTicketInclusionText) {
        throw new Error("条款页签 1 保存后回读的儿童门票景点文本不一致");
      }
    }
    savedTabs.push({ tabEnum, packageId, itemCount: items.length });
  }
  return { savedTabs };
}
