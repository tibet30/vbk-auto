// @ts-nocheck
/**
 * VBK 新版结构化条款接口。
 *
 * 契约来源：真实 newResourceClause 页面与 tour-chrome-extension 的
 * saveClauses.ts。所有请求都在已登录 VBK Page 内执行，复用页面 cookie；
 * 不把认证信息搬到主进程，也不绕过官方条款包校验。
 */

const CLAUSE_HEAD = {
  cid: "09031059218989378081",
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
  flightForceMajeureNotice: 98,
  complimentaryActivityNotice: 383,
} as const;

const LODGING_SELF_PAY_NOTE = "单房差及儿童占床费用（如产生），具体金额以出行前实际确认为准";
// Saved platform clause IDs. The page-context payload is kept ID-only as well.
export const DEFAULT_SELECTED_CLAUSE_IDS = {
  1: [38536, 10095, 7, 10091, 13, 10087, 3014],
  2: [REQUIRED_CLAUSE_IDS.outboundTransportExcluded, 1079],
  3: [3031, 46],
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

export function formatSelectedClauseItems(clauseTypeDtos) {
  const result = [];
  for (const type of clauseTypeDtos ?? []) {
    const selectedItems = [
      ...(type.clauseItemDtos ?? []),
      ...(type.containers ?? []).flatMap((container) =>
        (container.clauseItemDtos ?? []).map((item) => ({
          ...item,
          selected: container.selectedClauseItemId == null
            ? item.selected
            : String(item.clauseItemId) === String(container.selectedClauseItemId) ? "T" : "F",
        })),
      ),
    ].filter((item) => {
      if (item.itemType != null && item.itemType !== "F") return false;
      if (item.isShow != null && item.isShow !== "T") return false;
      if (item.hasSelectBox === "F") return true;
      return item.selected === "T";
    });
    for (const item of selectedItems) {
      result.push({
        clauseItemId: item.clauseItemId,
        secondClassTypeId: type.clauseTypeId,
        elementDtos: (item.clauseComponentDtos ?? []).map((component) => {
          const element = component.componentElementDtos?.find(
            (candidate) => candidate.elementCode === component.value,
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

export function ensureRequiredClause(items, clauseTypeDtos, clauseItemId) {
  if (items.some((item) => item.clauseItemId === clauseItemId)) return items;
  for (const type of clauseTypeDtos ?? []) {
    const candidates = [
      ...(type.clauseItemDtos ?? []),
      ...(type.containers ?? []).flatMap((container) => container.clauseItemDtos ?? []),
    ];
    const target = candidates.find((item) => item.clauseItemId === clauseItemId);
    if (!target) continue;
    return [
      ...items,
      {
        clauseItemId: target.clauseItemId,
        secondClassTypeId: type.clauseTypeId,
        elementDtos: (target.clauseComponentDtos ?? []).map((component) => {
          const element = component.componentElementDtos?.find(
            (candidate) => candidate.elementCode === component.value,
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

export function setClauseComponentValue(items, clauseItemId, componentCode, value) {
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

export async function saveStructuredProductClauses(page, productId, options = {}) {
  const isFreeTravel = options?.productForm === "freeTravel";
  return page.evaluate(async ({ productId, head, requiredIds, defaultSelectedClauseIds, lodgingSelfPayNote, isFreeTravel }) => {
    const request = async (url, body, contentType = "application/json") => {
      const response = await fetch(url, {
        method: "POST",
        credentials: "include",
        headers: {
          accept: "*/*",
          "content-type": contentType,
          cookieorigin: "https://vbooking.ctrip.com",
          "x-ctx-locale": "zh-CN",
        },
        body: JSON.stringify(body),
      });
      const text = await response.text();
      let data = {};
      try { data = text ? JSON.parse(text) : {}; } catch { /* handled below */ }
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
      const ack = data?.ResponseStatus?.Ack;
      const errors = data?.ResponseStatus?.Errors;
      if (ack === "Failure" || ack === "Warning" || (Array.isArray(errors) && errors.length)) {
        const detail = errors?.map((error) => error.Message ?? error.ErrorCode).join("；") || ack;
        throw new Error(`${url.split("/").pop()} 失败：${detail}`);
      }
      return data;
    };

    const format = (clauseTypes) => {
      const result = [];
      for (const type of clauseTypes ?? []) {
        const selected = [
          ...(type.clauseItemDtos ?? []),
          ...(type.containers ?? []).flatMap((container) =>
            (container.clauseItemDtos ?? []).map((item) => ({
              ...item,
              selected: container.selectedClauseItemId == null
                ? item.selected
                : String(item.clauseItemId) === String(container.selectedClauseItemId) ? "T" : "F",
            })),
          ),
        ].filter((item) => {
          if (item.itemType != null && item.itemType !== "F") return false;
          if (item.isShow != null && item.isShow !== "T") return false;
          if (item.hasSelectBox === "F") return true;
          return item.selected === "T";
        });
        for (const item of selected) {
          result.push({
            clauseItemId: item.clauseItemId,
            secondClassTypeId: type.clauseTypeId,
            elementDtos: (item.clauseComponentDtos ?? []).map((component) => {
              const element = component.componentElementDtos?.find(
                (candidate) => candidate.elementCode === component.value,
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
    };

    const ensure = (items, clauseTypes, id) => {
      if (items.some((item) => item.clauseItemId === id)) return items;
      for (const type of clauseTypes ?? []) {
        const candidates = [
          ...(type.clauseItemDtos ?? []),
          ...(type.containers ?? []).flatMap((container) => container.clauseItemDtos ?? []),
        ];
        const target = candidates.find((item) => item.clauseItemId === id);
        if (!target) continue;
        const copy = format([{ ...type, clauseItemDtos: [{ ...target, selected: "T" }], containers: [] }]);
        return [...items, ...copy];
      }
      throw new Error(`VBK 条款包缺少必选条款 ${id}`);
    };

    const setValue = (items, itemId, componentCode, value) => {
      let found = false;
      const next = items.map((item) => {
        if (item.clauseItemId !== itemId) return item;
        const elementDtos = (item.elementDtos ?? []).map((element) => {
          if (element.componentCode !== componentCode) return element;
          found = true;
          return { ...element, value };
        });
        return { ...item, elementDtos };
      });
      if (!found) throw new Error(`VBK 条款 ${itemId} 缺少组件 ${componentCode}`);
      return next;
    };

    const savedTabs = [];
    // VBK 会在保存其它页签时做跨页校验；先落住宿费用页，避免“请勾选住宿条款”。
    for (const tabEnum of [2, 1, 3, 4]) {
      const productClause = await request(
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
      const clausePackage = await request(
        "https://online.ctrip.com/restapi/soa2/20046/getClausePackage",
        getBody,
        "text/plain;charset=UTF-8",
      );
      let items = format(clausePackage.clauseTypeDtos);
      if (tabEnum === 1 && !isFreeTravel) {
        items = ensure(items, clausePackage.clauseTypeDtos, requiredIds.mandarinGuide);
        items = ensure(items, clausePackage.clauseTypeDtos, requiredIds.itineraryHotelIncluded);
        items = ensure(items, clausePackage.clauseTypeDtos, requiredIds.hotelTwoPerRoom);
        items = ensure(items, clausePackage.clauseTypeDtos, requiredIds.childNoBed);
      }
      if (tabEnum === 2 && !isFreeTravel) {
        items = ensure(items, clausePackage.clauseTypeDtos, requiredIds.lodgingIncluded);
        items = setValue(items, requiredIds.lodgingIncluded, "otherfeewithout1", lodgingSelfPayNote);
      }
      if (tabEnum === 3 && !isFreeTravel) items = ensure(items, clausePackage.clauseTypeDtos, requiredIds.minorWithAdult);
      if (!isFreeTravel) {
        for (const clauseItemId of defaultSelectedClauseIds[tabEnum] ?? []) {
          items = ensure(items, clausePackage.clauseTypeDtos, clauseItemId);
        }
      }
      let savePackage;
      try {
        savePackage = await request(
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
      await request(
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
      const persistedClauseData = await request(
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
      const persistedPackage = await request(
        "https://online.ctrip.com/restapi/soa2/20046/getClausePackage",
        persistedBody,
        "text/plain;charset=UTF-8",
      );
      const persistedIds = new Set(format(persistedPackage.clauseTypeDtos).map((item) => item.clauseItemId));
      const missingIds = isFreeTravel
        ? []
        : (defaultSelectedClauseIds[tabEnum] ?? []).filter((id) => !persistedIds.has(id));
      if (missingIds.length > 0) {
        throw new Error(`条款页签 ${tabEnum} 保存后回读缺少条款：${missingIds.join(",")}`);
      }
      savedTabs.push({ tabEnum, packageId, itemCount: items.length });
    }
    return { savedTabs };
  }, {
    productId: String(productId),
    head: CLAUSE_HEAD,
    requiredIds: REQUIRED_CLAUSE_IDS,
    defaultSelectedClauseIds: DEFAULT_SELECTED_CLAUSE_IDS,
    lodgingSelfPayNote: LODGING_SELF_PAY_NOTE,
    isFreeTravel,
  });
}
