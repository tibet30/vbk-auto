import {
  DEFAULT_SELECTED_CLAUSE_IDS,
  OPTIONAL_NOTICE_CLAUSE_IDS,
} from "../../src/main/automation/ctrip/clauses-api.js";

export function noPageClauseClient(
  tamperReadback = false,
  childBookable = true,
  optional: { omit?: number[]; tamperMinutes?: boolean } = {},
) {
  const saved = new Map<number, any[]>();
  const savedUnbookingRules = new Map<number, any[]>();
  const order: number[] = [];
  const client = {
    nativeOnly: true,
    evaluate: async () => { throw new Error("页面已关闭"); },
    vbkSessionFetch: async ({ endpoint, body }: any) => {
      let data: any = {};
      const tab = body.tabEnum ?? body.testTab;
      if (endpoint.endsWith("listProductClauses")) {
        data.centralDataDto = { testTab: tab, additionalInfoDto: { firstClassTypeIds: [tab] }, filterConditionDto: { pICategoryId: 1003 } };
        const holidayRule = savedUnbookingRules.get(tab)?.find((rule) => rule.isHoliday === "T");
        data.unBookingContentDto = { holidayRuleDto: holidayRule ?? {} };
      } else if (endpoint.endsWith("getClausePackage")) {
        const persisted = saved.get(tab);
        const ids = DEFAULT_SELECTED_CLAUSE_IDS[tab as keyof typeof DEFAULT_SELECTED_CLAUSE_IDS];
        const optionalItems = tab !== 4 ? [] : OPTIONAL_NOTICE_CLAUSE_IDS
          .filter((id) => !optional.omit?.includes(id))
          .map((id) => {
            const item = persisted?.find((candidate) => candidate.clauseItemId === id);
            const saved491 = item?.elementDtos.find((element: any) => element.componentCode === "tripnoticeinput1")?.value ?? "";
            return { clauseItemId: id, itemType: "F", isShow: "T", selected: item ? "T" : "F",
              clauseComponentDtos: id === 491
                ? [{ componentCode: "tripnoticeinput1", value: optional.tamperMinutes && item ? "90" : saved491 }]
                : [] };
          });
        data.clauseTypeDtos = [{ clauseTypeId: tab, clauseItemDtos: [...optionalItems, ...ids.filter(id => childBookable || ![10091, 10087].includes(id)).map(id => {
          const item = persisted?.find(item => item.clauseItemId === id);
          const component = id === 13 ? "landticketremarks" : id === 10087 ? "landticket2" : id === 1079 ? "otherfeewithout1" : undefined;
          const value = item?.elementDtos.find((element: any) => element.componentCode === component)?.value ?? "";
          return { clauseItemId: id, itemType: "F", isShow: "T", selected: "T", clauseComponentDtos: component
            ? [{ componentCode: component, value: tamperReadback && persisted && id === 13 ? "错误景点" : value }] : [] };
        })], containers: [] }];
      } else if (endpoint.endsWith("saveClausePackage")) {
        order.push(tab);
        saved.set(tab, body.clausePackageItemDtos);
        data.clausePackageId = 1000 + tab;
      } else if (endpoint.endsWith("saveProductClauses.json")) {
        savedUnbookingRules.set(tab, body.unBookingRuleDtos.map((rule: any) => ({
          ...rule,
          lossValue: Number(rule.lossValue) / 100,
          travelAgencyLossValue: Number(rule.travelAgencyLossValue) / 100,
        })));
      }
      return { status: 200, payload: { ResponseStatus: { Ack: "Success" }, ...data }, durationMs: 1, ctx: {} as any };
    },
  };
  return { client, order, saved, savedUnbookingRules };
}
